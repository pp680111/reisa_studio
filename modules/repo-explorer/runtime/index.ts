import type {
  JsonValue,
  ModuleActivation,
  ModuleContext,
  RuntimeModule,
  ToolExecutionContext,
  ToolRegistration,
  ToolResult,
} from '@reisa/module-sdk';
import { toolFailure, toolSuccess } from '@reisa/module-sdk';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MAX_GLOB_MATCHES,
  MAX_GREP_MATCHES,
  MAX_LS_ENTRIES,
  MAX_READ_LINES,
  DEFAULT_READ_LINES,
  repoExplorerGlob,
  repoExplorerGrep,
  repoExplorerListRepos,
  repoExplorerLs,
  repoExplorerReadFile,
} from '../contracts.ts';

/** grep 工具的入参形态（contracts 导出的是 Typebox schema 值，此处同步其字段）。 */
interface GrepToolInput {
  pattern: string;
  path: string;
  glob?: string;
  maxCount?: number;
}
import {
  createRegistration,
  loadRegistry,
  normalizeTags,
  saveRegistry,
  type RepoRegistration,
} from './config.ts';
import {
  SandboxError,
  resolveVirtualPath,
  validateSearchPattern,
  verifyWithinRepo,
  virtualRepoPath,
  type SandboxTarget,
} from './sandbox.ts';
import {
  compileGlob,
  grepTree,
  listDirectory,
  loadIgnoreMatcher,
  makeGlobFilter,
  readFileLines,
  walkTree,
  ToolFileError,
} from './tools.ts';

/**
 * 代码仓库检索模块运行入口。只能被组合根导入（边界检查约定）；不加载任何 UI 代码。
 * 工具执行与注册表变更共用一把模块锁：调用期间注册表不会被切换或半更新。
 */

export interface CreateRepoExplorerRuntimeOptions {
  /** 组合根注入：注册本模块的页面服务（受限 IPC 使用）。 */
  readonly registerPageService?: (invoke: PageServiceInvoke) => void;
}

/** 页面服务调用上下文：信号与模块停用关联（架构设计 §10.2）。 */
export interface PageServiceContext {
  readonly signal?: AbortSignal;
}

export type PageServiceInvoke = (
  action: string,
  input: JsonValue,
  context?: PageServiceContext,
) => Promise<JsonValue>;

/** 模块级串行化：工具/页面调用与注册表变更共用一把锁（knowledge AsyncMutex 语义）。 */
class AsyncMutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export class RepoExplorerRuntime implements RuntimeModule {
  readonly id = 'repo-explorer';
  readonly version = '0.1.0';
  readonly protocolVersion = '1' as const;

  #context: ModuleContext | undefined;
  #registry: readonly RepoRegistration[] = [];
  readonly #mutex = new AsyncMutex();

  async activate(context: ModuleContext): Promise<ModuleActivation> {
    this.#context = context;
    this.#registry = await loadRegistry(context.config, context.logger);
    return {
      tools: [
        this.#listReposTool(),
        this.#lsTool(),
        this.#readFileTool(),
        this.#globTool(),
        this.#grepTool(),
      ],
      deactivate: async () => {
        this.#registry = [];
        this.#context = undefined;
      },
    };
  }

  #require(): { context: ModuleContext; registry: readonly RepoRegistration[] } {
    if (this.#context === undefined) throw new Error('代码仓库模块未激活');
    return { context: this.#context, registry: this.#registry };
  }

  /** SandboxError / ToolFileError → SDK 结构化失败；OS 错误脱敏后归一。 */
  #toFailure(
    error: unknown,
    target: SandboxTarget | undefined,
    context: ToolExecutionContext,
  ): ToolResult {
    if (error instanceof SandboxError) {
      return error.code === 'unregistered_repo'
        ? toolFailure('RESOURCE_NOT_FOUND', error.message, context.invocationId)
        : toolFailure('INVALID_INPUT', error.message, context.invocationId);
    }
    if (error instanceof ToolFileError) {
      return error.code === 'not_found'
        ? toolFailure('RESOURCE_NOT_FOUND', error.message, context.invocationId)
        : toolFailure('INVALID_INPUT', error.message, context.invocationId);
    }
    if ((error as { code?: unknown } | undefined)?.code === 'ENOENT') {
      return toolFailure(
        'RESOURCE_NOT_FOUND',
        `路径不存在：${target?.virtualPath ?? '(未知)'}`,
        context.invocationId,
      );
    }
    return toolFailure('EXECUTION_FAILED', sanitizeError(error, target), context.invocationId);
  }

  /** 在模块锁内执行一次以虚拟路径为目标的读操作：解析 → realpath 复验 → 执行。 */
  async #runScoped<T>(
    rawPath: unknown,
    execute: (target: SandboxTarget) => Promise<T>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    return this.#mutex.run(async () => {
      let target: SandboxTarget | undefined;
      try {
        target = resolveVirtualPath(this.#require().registry, rawPath);
        await verifyWithinRepo(target.repo, target.absolutePath);
        return toolSuccess((await execute(target)) as unknown as JsonValue);
      } catch (error) {
        return this.#toFailure(error, target, context);
      }
    });
  }

  // ---- Agent 能力（只读检索）；管理面操作见 pageService，绝不注册为能力 ----

  #listReposTool(): ToolRegistration {
    return {
      definition: repoExplorerListRepos,
      execute: async (_rawInput, context) => {
        return this.#mutex.run<ToolResult>(async () => {
          const { registry } = this.#require();
          return toolSuccess({
            repos: registry
              .filter((repo) => repo.enabled)
              .map((repo) => ({
                name: repo.name,
                path: virtualRepoPath(repo.name),
                tags: [...repo.tags],
                description: repo.description === '' ? null : repo.description,
              })),
          } as unknown as JsonValue);
        });
      },
    };
  }

  #lsTool(): ToolRegistration {
    return {
      definition: repoExplorerLs,
      execute: async (rawInput, context) => {
        const input = rawInput as { path: string };
        return this.#runScoped(
          input.path,
          async (target) => {
            if ((await stat(target.absolutePath)).isDirectory() === false) {
              throw new ToolFileError('is_directory', '目标不是目录，读取文件请使用 read_file');
            }
            const matcher = await loadIgnoreMatcher(target.repo.path);
            const { entries, truncated } = await listDirectory(target.absolutePath, MAX_LS_ENTRIES);
            const filtered = entries.filter(
              (entry) => matcher.ignores(joinRelative(target.relativePart, entry.name)) === false,
            );
            return {
              path: target.virtualPath,
              entries: filtered,
              truncated: truncated || filtered.length < entries.length,
            };
          },
          context,
        );
      },
    };
  }

  #readFileTool(): ToolRegistration {
    return {
      definition: repoExplorerReadFile,
      execute: async (rawInput, context) => {
        const input = rawInput as { path: string; offset?: number; limit?: number };
        const offset = clampInt(input.offset, 1, Number.MAX_SAFE_INTEGER, 1);
        const limit = clampInt(input.limit, 1, MAX_READ_LINES, DEFAULT_READ_LINES);
        return this.#runScoped(
          input.path,
          async (target) => {
            const page = await readFileLines(target.absolutePath, offset, limit);
            return { path: target.virtualPath, ...page };
          },
          context,
        );
      },
    };
  }

  #globTool(): ToolRegistration {
    return {
      definition: repoExplorerGlob,
      execute: async (rawInput, context) => {
        const input = rawInput as { pattern: string; path: string };
        return this.#mutex.run(async () => {
          let target: SandboxTarget | undefined;
          try {
            const { registry } = this.#require();
            const pattern = validateSearchPattern(input.pattern, 'glob');
            target = resolveVirtualPath(registry, input.path);
            await verifyWithinRepo(target.repo, target.absolutePath);
            if ((await stat(target.absolutePath)).isDirectory() === false) {
              throw new ToolFileError('is_directory', '搜索根必须是目录');
            }
            const matcher = await loadIgnoreMatcher(target.repo.path);
            const match = compileGlob(pattern);
            const state = { visited: 0, truncated: false };
            const matches: string[] = [];
            let hitCap = false;
            for await (const entry of walkTree(target.absolutePath, matcher, state)) {
              if (matches.length >= MAX_GLOB_MATCHES) {
                hitCap = true;
                break;
              }
              if (match(entry.searchRelative)) {
                matches.push(virtualJoin(target, entry.searchRelative));
              }
            }
            return toolSuccess({
              matches,
              truncated: hitCap || state.truncated,
            } as unknown as JsonValue);
          } catch (error) {
            return this.#toFailure(error, target, context);
          }
        });
      },
    };
  }

  #grepTool(): ToolRegistration {
    return {
      definition: repoExplorerGrep,
      execute: async (rawInput, context) => {
        const input = rawInput as unknown as GrepToolInput;
        return this.#mutex.run(async () => {
          let target: SandboxTarget | undefined;
          try {
            const { registry } = this.#require();
            const regex = new RegExp(validateSearchPattern(input.pattern, 'regex'));
            const maxCount = clampInt(input.maxCount, 1, MAX_GREP_MATCHES, 50);
            target = resolveVirtualPath(registry, input.path);
            await verifyWithinRepo(target.repo, target.absolutePath);
            const matcher = await loadIgnoreMatcher(target.repo.path);
            const outcome = await grepTree({
              root: target.absolutePath,
              virtualPrefix: target.virtualPath,
              regex,
              fileFilter: makeGlobFilter(input.glob),
              maxCount,
              matcher,
            });
            return toolSuccess(outcome as unknown as JsonValue);
          } catch (error) {
            return this.#toFailure(error, target, context);
          }
        });
      },
    };
  }

  // ---- 页面服务：注册表管理面，经受限 IPC 通道，不进 Agent 能力集合 ----

  pageService(): PageServiceInvoke {
    return (action, input) =>
      this.#mutex.run(async () => {
        const { context, registry } = this.#require();
        const payload = (input ?? {}) as Record<string, unknown>;
        switch (action) {
          case 'list_repos':
            return registry.map(toRepoJson) as unknown as JsonValue;
          case 'add_repo': {
            const registration = createRegistration({
              name: payload['name'],
              path: payload['path'],
              tags: payload['tags'],
              description: payload['description'],
            });
            if (registry.some((repo) => repo.name === registration.name)) {
              throw new Error(`仓库名 ${registration.name} 已存在`);
            }
            const next = [...registry, registration];
            await saveRegistry(context.config, next);
            this.#registry = next;
            return toRepoJson(registration) as unknown as JsonValue;
          }
          case 'update_repo': {
            const id = String(payload['id'] ?? '');
            const existing = registry.find((repo) => repo.id === id);
            if (existing === undefined) throw new Error('仓库不存在');
            let name = existing.name;
            if (payload['name'] !== undefined) {
              name = String(payload['name']).trim();
              if (name !== existing.name && registry.some((repo) => repo.name === name)) {
                throw new Error(`仓库名 ${name} 已存在`);
              }
            }
            const updated: RepoRegistration = {
              ...existing,
              name,
              tags:
                payload['tags'] !== undefined ? normalizeTags(payload['tags']) : existing.tags,
              description:
                payload['description'] !== undefined
                  ? String(payload['description']).trim()
                  : existing.description,
              enabled:
                payload['enabled'] !== undefined ? payload['enabled'] === true : existing.enabled,
            };
            const next = registry.map((repo) => (repo.id === id ? updated : repo));
            await saveRegistry(context.config, next);
            this.#registry = next;
            return toRepoJson(updated) as unknown as JsonValue;
          }
          case 'remove_repo': {
            const id = String(payload['id'] ?? '');
            const existing = registry.find((repo) => repo.id === id);
            if (existing === undefined) throw new Error('仓库不存在');
            const next = registry.filter((repo) => repo.id !== id);
            await saveRegistry(context.config, next);
            this.#registry = next;
            return { removed: existing.name } as unknown as JsonValue;
          }
          case 'test_repo':
            return testRepoPath(String(payload['path'] ?? ''));
          default:
            throw new Error(`未知的页面服务操作：${action}`);
        }
      });
  }
}

// ---- 模块级辅助 ----

function joinRelative(base: string, name: string): string {
  const posixBase = base === '' ? '' : `${base.replaceAll('\\', '/')}/`;
  return `${posixBase}${name}`;
}

function virtualJoin(target: SandboxTarget, searchRelative: string): string {
  return `${target.virtualPath}${searchRelative.replaceAll('\\', '/')}`;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (Number.isFinite(value) === false) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toRepoJson(repo: RepoRegistration): JsonValue {
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    tags: [...repo.tags],
    description: repo.description,
    enabled: repo.enabled,
    createdAt: repo.createdAt,
  } as unknown as JsonValue;
}

/** test_repo：登记前实测目录（可读性 + 是否 Git 仓库），永不抛错。 */
async function testRepoPath(rawPath: string): Promise<{
  ok: boolean;
  isGit?: boolean;
  error?: string;
}> {
  if (rawPath.trim() === '') return { ok: false, error: '未选择目录' };
  try {
    const real = resolve(await realpath(rawPath.trim()));
    if ((await stat(real)).isDirectory() === false) return { ok: false, error: '目标不是目录' };
    const git = await stat(resolve(real, '.git')).catch(() => undefined);
    return { ok: true, isGit: git !== undefined };
  } catch {
    return { ok: false, error: '目录不可访问' };
  }
}

/** OS 错误消息脱敏：仓库根真实路径与解析目标替换为虚拟路径。 */
function sanitizeError(error: unknown, target: SandboxTarget | undefined): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (target === undefined) return '仓库检索执行失败';
  let message = raw;
  for (const variant of [target.repo.path, target.absolutePath]) {
    if (variant) message = message.split(variant).join(target.virtualPath);
  }
  return message;
}

/** 组合根入口：创建代码仓库检索运行时模块。 */
export function createRepoExplorerRuntime(
  options: CreateRepoExplorerRuntimeOptions = {},
): RuntimeModule {
  const runtime = new RepoExplorerRuntime();
  if (options.registerPageService) {
    options.registerPageService(runtime.pageService());
  }
  return runtime;
}

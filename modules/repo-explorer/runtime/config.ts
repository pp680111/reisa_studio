import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { JsonValue, ModuleConfigScope, ModuleLogger } from '@reisa/module-sdk';
import { REPO_NAME_RE } from './sandbox.ts';

/**
 * 仓库注册表（模块私有 settings.json，key="repos"；对齐 knowledge loadSettings 模式）。
 * 注册表是页面服务的管理面数据：增删改经受限页面通道，工具执行只读内存快照。
 */

export const REGISTRY_CONFIG_KEY = 'repos';

export interface RepoRegistration {
  readonly id: string;
  /** 虚拟路径段，全局唯一；^[A-Za-z0-9][A-Za-z0-9._-]*$ */
  readonly name: string;
  /** 宿主机绝对目录（登记时 realpath 归一化）。 */
  readonly path: string;
  readonly tags: readonly string[];
  readonly description: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** 登记新仓库时的输入校验：返回规范化条目或抛出带中文原因的错误。 */
export function createRegistration(input: {
  name: unknown;
  path: unknown;
  tags?: unknown;
  description?: unknown;
}): RepoRegistration {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (REPO_NAME_RE.test(name) === false) {
    throw new Error(`仓库名不合法：${name || '(空)'}。只允许字母数字开头，含 . _ - 的标识`);
  }
  if (typeof input.path !== 'string' || isAbsolute(input.path) === false) {
    throw new Error('仓库路径必须是宿主机绝对目录');
  }
  const resolved = resolve(input.path);
  const info = statSync(resolved, { throwIfNoEntry: false });
  if (info?.isDirectory() !== true) throw new Error('仓库路径不存在或不是目录');
  return {
    id: `repo_${randomUUID()}`,
    name,
    // realpath 归一化：后续沙箱复验与脱敏都基于真实路径
    path: resolve(realpathSync(resolved)),
    tags: normalizeTags(input.tags),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    enabled: true,
    createdAt: Date.now(),
  };
}

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
        .map((tag) => tag.trim()),
    ),
  ];
}

/** 读取并归一化注册表：非法条目跳过并告警，不阻断激活（对齐 ops_agent load_repo_registry 容错）。 */
export async function loadRegistry(
  config: ModuleConfigScope,
  logger?: ModuleLogger,
): Promise<RepoRegistration[]> {
  const raw = await config.get<JsonValue>(REGISTRY_CONFIG_KEY);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const valid: RepoRegistration[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      logger?.warn('repo_registry_entry_skipped', { reason: 'not_object' } as JsonValue);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    const path = typeof record['path'] === 'string' ? record['path'] : '';
    if (REPO_NAME_RE.test(name) === false || path === '' || isAbsolute(path) === false) {
      logger?.warn('repo_registry_entry_skipped', { reason: 'invalid_fields', name } as JsonValue);
      continue;
    }
    if (seen.has(name)) {
      logger?.warn('repo_registry_entry_skipped', { reason: 'duplicate_name', name } as JsonValue);
      continue;
    }
    seen.add(name);
    valid.push({
      id: typeof record['id'] === 'string' ? record['id'] : `repo_${randomUUID()}`,
      name,
      path,
      tags: normalizeTags(record['tags']),
      description: typeof record['description'] === 'string' ? record['description'] : '',
      enabled: record['enabled'] !== false,
      createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : Date.now(),
    });
  }
  return valid;
}

export async function saveRegistry(
  config: ModuleConfigScope,
  repos: readonly RepoRegistration[],
): Promise<void> {
  await config.set(REGISTRY_CONFIG_KEY, repos as unknown as JsonValue);
}

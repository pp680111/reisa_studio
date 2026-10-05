import type {
  JsonValue,
  ModuleActivation,
  ModuleContext,
  RuntimeModule,
  ToolRegistration,
  ToolExecutionContext,
  ToolResult,
} from '@reisa/module-sdk';
import { toolFailure, toolSuccess } from '@reisa/module-sdk';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  knowledgeListDocuments,
  knowledgeReadDocument,
  knowledgeSearch,
  knowledgeUploadDocument,
  type SearchModeValue,
} from '../contracts.ts';
import { EMBEDDING_IDENTITY_KEY, MetadataDB, type Document, type Source } from './db.ts';
import { EmbeddingError, OpenAICompatibleEmbeddingClient, type Embedder } from './embedding.ts';
import { SyncService, safeMessage, type SyncStatus } from './sync.ts';
import { KnowledgeBase, ServiceError, uploadsPathFor } from './service.ts';
import { ChunkStore, type SearchMode } from './store.ts';
import {
  CONFIG_KEY,
  embedderStatus,
  embeddingIdentity,
  loadSettings,
  saveSettings,
  type KnowledgeSettings,
} from './config.ts';

/**
 * 知识库模块运行入口（迁移自 skb main.py 的组装根）。
 * 只能被组合根导入（边界检查约定）；不加载任何 UI 代码。
 */

export interface CreateKnowledgeRuntimeOptions {
  /** 组合根注入：注册本模块的页面服务（受限 IPC 使用；见迁移设计文档 §8.1）。 */
  readonly registerPageService?: (invoke: PageServiceInvoke) => void;
  /** 测试注入：替代默认元数据库构造（生产不传，走真实 SQLite）。 */
  readonly createDatabase?: (path: string) => MetadataDB;
  /** 测试注入：替代默认向量库打开（生产不传，走真实 LanceDB）。 */
  readonly openChunkStore?: (path: string, dimensions: number) => Promise<ChunkStore>;
}

/** 页面服务调用上下文：信号与模块停用关联，宿主停用即取消（架构设计 §10.2）。 */
export interface PageServiceContext {
  readonly signal?: AbortSignal;
}

export type PageServiceInvoke = (
  action: string,
  input: JsonValue,
  context?: PageServiceContext,
) => Promise<JsonValue>;

interface KnowledgeRuntimeServices {
  readonly settings: KnowledgeSettings;
  readonly database: MetadataDB;
  readonly store: ChunkStore;
  readonly service: KnowledgeBase;
  readonly sync: SyncService;
}

/** 模块级串行化：工具/页面调用与重新配置共用一把锁（skb asyncio.Lock 语义）。 */
class AsyncMutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export class KnowledgeRuntime implements RuntimeModule {
  readonly id = 'knowledge';
  readonly version = '0.1.0';
  readonly protocolVersion = '1' as const;

  #context: ModuleContext | undefined;
  #services: KnowledgeRuntimeServices | undefined;
  readonly #mutex = new AsyncMutex();
  readonly #createDatabase: (path: string) => MetadataDB;
  readonly #openChunkStore: (path: string, dimensions: number) => Promise<ChunkStore>;

  constructor(options: CreateKnowledgeRuntimeOptions = {}) {
    this.#createDatabase = options.createDatabase ?? ((path) => new MetadataDB(path));
    this.#openChunkStore =
      options.openChunkStore ?? ((path, dimensions) => ChunkStore.open(path, dimensions));
  }

  async activate(context: ModuleContext): Promise<ModuleActivation> {
    this.#context = context;
    this.#services = await this.#buildServices(context, { autostart: true });
    return {
      tools: [
        this.#searchTool(),
        this.#listDocumentsTool(),
        this.#readDocumentTool(),
        this.#uploadDocumentTool(),
      ],
      deactivate: () => this.#deactivate(),
    };
  }

  async #deactivate(): Promise<void> {
    const services = this.#services;
    this.#services = undefined;
    this.#context = undefined;
    await this.#disposeServices(services);
  }

  /** 释放一组运行服务：停后台同步（等待在途任务结束）→ 关元数据库 → 关向量库。 */
  async #disposeServices(services: KnowledgeRuntimeServices | undefined): Promise<void> {
    if (services === undefined) return;
    await services.sync.stop();
    services.database.close();
    await services.store.close();
  }

  /** skb main.build_knowledge_base 的启动顺序：建表 → 指纹校验 → 开库 → 组装。 */
  async #buildServices(
    context: ModuleContext,
    options: { autostart?: boolean } = {},
  ): Promise<KnowledgeRuntimeServices> {
    const settings = await loadSettings(context.config);
    const dataDir = context.storage.dataDir;
    let database: MetadataDB | undefined;
    let store: ChunkStore | undefined;
    let sync: SyncService | undefined;
    try {
      database = this.#createDatabase(join(dataDir, 'data.sqlite'));
      const indexDir = join(dataDir, 'index');

      // embedding 配置指纹：端点/模型/维度变更 → 清空索引与文档记录全量重建（保留 sources）
      const identity = embeddingIdentity(settings.embedding);
      const stored = database.getSetting(EMBEDDING_IDENTITY_KEY);
      if (stored !== identity) {
        const hasData = database.listDocuments({ limit: 1 }).total > 0;
        if (hasData) {
          context.logger.info('embedding_identity_changed', {
            from: stored ?? null,
            to: identity,
          } as JsonValue);
          await rm(indexDir, { recursive: true, force: true });
          database.deleteAllDocuments();
        }
        database.setSetting(EMBEDDING_IDENTITY_KEY, identity);
      }

      store = await this.#openChunkStore(indexDir, settings.embedding.dimensions);
      const status = embedderStatus(settings.embedding);
      const embedder: Embedder | null = status.enabled
        ? new OpenAICompatibleEmbeddingClient({
            apiKey: settings.embedding.apiKey,
            baseUrl: settings.embedding.baseUrl,
            model: settings.embedding.model,
            dimensions: settings.embedding.dimensions,
            batchSize: settings.embedding.batchSize,
            maxConcurrency: settings.embedding.maxConcurrency,
            timeoutSeconds: settings.embedding.timeoutSeconds,
            maxRetries: settings.embedding.maxRetries,
            rateLimitRetryDelaySeconds: settings.embedding.rateLimitRetryDelaySeconds,
          })
        : null;
      if (!status.enabled) {
        context.logger.info('embedding_disabled', { reason: status.reason ?? null } as JsonValue);
      }

      sync = new SyncService({
        database,
        store,
        embedder,
        intervalSeconds: settings.syncIntervalSeconds,
        debounceSeconds: settings.syncDebounceSeconds,
        autoIndexMaxBytes: settings.autoIndexMaxBytes,
        logger: context.logger,
      });
      const service = new KnowledgeBase({
        uploadsPath: uploadsPathFor(dataDir),
        database,
        store,
        embedder,
        sync,
        uploadMaxBytes: settings.uploadMaxBytes,
        logger: context.logger,
      });

      await service.migrateUploadSources();
      await service.ensureUploadsSource();
      // 建资源与启动后台工作分离：重配置路径在切换完成后才启动，避免新旧双同步循环
      if (options.autostart === true) sync.start();
      return { settings, database, store, service, sync };
    } catch (error) {
      // 清理已部分建好的新资源：重配置失败时旧服务保持完整可用
      await sync?.stop();
      database?.close();
      await store?.close();
      throw error;
    }
  }

  /**
   * 重新配置核心（调用方须持有模块锁）：先按新配置完整建好新服务（不含后台同步），
   * 成功后才释放旧资源并切换——初始化失败时旧服务原样保留，工具继续可用。
   */
  async #swapServices(context: ModuleContext): Promise<void> {
    const previous = this.#services;
    const fresh = await this.#buildServices(context);
    try {
      // 换新点前后在途调用已被模块锁排除：此时停旧同步 → 关旧库/旧向量库 → 切换引用
      if (previous) {
        await previous.sync.stop();
        previous.database.close();
        await previous.store.close();
      }
    } catch (error) {
      // 旧资源释放失败则无法回退到旧服务：清掉半成品并显式暴露，不静默假活
      await this.#disposeServices(fresh);
      context.logger.error('knowledge_reconfigure_unrecoverable', {
        message: error instanceof Error ? error.message : String(error),
      } as JsonValue);
      throw error;
    }
    this.#services = fresh;
    fresh.sync.start();
  }

  #require(): KnowledgeRuntimeServices {
    if (this.#services === undefined) throw new Error('知识库模块未激活');
    return this.#services;
  }

  // ---- 能力执行器：ServiceError → SDK 结构化失败（迁移设计文档 §7.1 错误映射） ----

  #toFailure(error: unknown, context: ToolExecutionContext): ToolResult {
    if (error instanceof ServiceError) {
      const invalidInput = [
        'query_empty',
        'mode_unsupported',
        'format_unsupported',
        'upload_empty',
        'upload_too_large',
        'ignore_rules_invalid',
        'source_path_invalid',
        'source_exists',
        'source_overlaps',
      ];
      const notFound = ['source_not_found', 'document_not_found'];
      if (invalidInput.includes(error.code)) {
        return toolFailure('INVALID_INPUT', error.message, context.invocationId);
      }
      if (notFound.includes(error.code)) {
        return toolFailure('RESOURCE_NOT_FOUND', error.message, context.invocationId);
      }
      const retryable = error.code === 'embedding_unavailable';
      return toolFailure('EXECUTION_FAILED', error.message, context.invocationId, { retryable });
    }
    if (error instanceof EmbeddingError) {
      return toolFailure('EXECUTION_FAILED', error.message, context.invocationId, {
        retryable: error.retryable,
      });
    }
    return toolFailure(
      'EXECUTION_FAILED',
      error instanceof Error ? error.message : String(error),
      context.invocationId,
    );
  }

  #searchTool(): ToolRegistration {
    return {
      definition: knowledgeSearch,
      execute: async (rawInput, context) => {
        const input = rawInput as { query: string; topK?: number; mode?: SearchModeValue };
        try {
          // 取消信号传入检索：中止向量请求，停用/用户取消不再等待数分钟重试（§10.3）。
          // 模块锁保证重配置切换期间本调用要么完整走旧服务、要么完整走新服务。
          const outcome = await this.#mutex.run(() =>
            this.#require().service.search({
              query: input.query,
              mode: input.mode ?? 'hybrid',
              topK: input.topK ?? 8,
              signal: context.signal,
            }),
          );
          return toolSuccess({
            query: outcome.query,
            mode: outcome.mode,
            degraded: outcome.degraded,
            results: outcome.results.map((hit) => ({
              documentId: hit.documentId,
              documentName: hit.documentName,
              content: hit.content,
              sectionPath: hit.sectionPath,
              lineStart: hit.lineStart,
              lineEnd: hit.lineEnd,
              score: hit.score,
            })),
          });
        } catch (error) {
          return this.#toFailure(error, context);
        }
      },
    };
  }

  #listDocumentsTool(): ToolRegistration {
    return {
      definition: knowledgeListDocuments,
      execute: async (rawInput, context) => {
        const input = (rawInput ?? {}) as { limit?: number; offset?: number };
        try {
          const { items, total } = await this.#mutex.run(async () =>
            this.#require().service.listDocuments({
              limit: input.limit ?? 50,
              offset: input.offset ?? 0,
            }),
          );
          return toolSuccess({
            total,
            items: items.map(toDocumentInfo),
          });
        } catch (error) {
          return this.#toFailure(error, context);
        }
      },
    };
  }

  #readDocumentTool(): ToolRegistration {
    return {
      definition: knowledgeReadDocument,
      execute: async (rawInput, context) => {
        const input = rawInput as { documentId: string };
        try {
          const { document, content, truncated } = await this.#mutex.run(() =>
            this.#require().service.documentContent(input.documentId),
          );
          return toolSuccess({
            id: document.id,
            name: document.name,
            status: document.status,
            content,
            truncated,
            contentTrusted: false,
          });
        } catch (error) {
          return this.#toFailure(error, context);
        }
      },
    };
  }

  #uploadDocumentTool(): ToolRegistration {
    return {
      definition: knowledgeUploadDocument,
      execute: async (rawInput, context) => {
        const input = rawInput as { filename: string; content: string };
        try {
          const receipt = await this.#mutex.run(() =>
            this.#require().service.upload(
              {
                filename: input.filename,
                data: Buffer.from(input.content, 'utf-8'),
              },
              context.signal,
            ),
          );
          return toolSuccess({
            name: receipt.name,
            sourceId: receipt.sourceId,
            status: 'queued',
          });
        } catch (error) {
          return this.#toFailure(error, context);
        }
      },
    };
  }

  // ---- 页面服务：管理面操作只属于页面，绝不注册为 Agent 能力（§5.3 安全分层） ----

  pageService(): PageServiceInvoke {
    // 页面动作与工具调用、重新配置共享模块锁：动作期间服务不会被切换或关闭
    return (action, input, context) =>
      this.#mutex.run(async () => {
        const signal = context?.signal;
        const { service, sync } = this.#require();
        const payload = (input ?? {}) as Record<string, unknown>;
        switch (action) {
          case 'get_stats': {
            const stats = service.stats();
            const perSource = service.sourceDocumentStats();
            const manualRequiredDocuments = perSource.reduce(
              (sum, item) => sum + item.manualRequiredDocuments,
              0,
            );
            return { ...stats, manualRequiredDocuments, perSource } as unknown as JsonValue;
          }
          case 'get_sync_status':
            return sync.status() as unknown as JsonValue;
          case 'list_sources':
            return service.listSources().map(toSourceJson) as unknown as JsonValue;
          case 'add_source': {
            const source = await service.addSource({
              path: String(payload['path'] ?? ''),
              ...(payload['name'] !== undefined ? { name: String(payload['name']) } : {}),
              ...(payload['ignoreRules'] !== undefined
                ? { ignoreRules: String(payload['ignoreRules']) }
                : {}),
            });
            return toSourceJson(source) as unknown as JsonValue;
          }
          case 'update_rules': {
            const source = await service.updateSourceRules(
              String(payload['sourceId'] ?? ''),
              String(payload['ignoreRules'] ?? ''),
            );
            return toSourceJson(source) as unknown as JsonValue;
          }
          case 'remove_source': {
            const source = await service.removeSource(String(payload['sourceId'] ?? ''));
            return toSourceJson(source) as unknown as JsonValue;
          }
          case 'scan_now':
            sync.wake();
            return { accepted: true };
          case 'reindex_document': {
            const document = await service.submitForIndex(String(payload['documentId'] ?? ''));
            return toDocumentJson(document) as unknown as JsonValue;
          }
          case 'list_documents': {
            const { items, total } = service.listDocuments({
              ...(payload['sourceId'] !== undefined
                ? { sourceId: String(payload['sourceId']) }
                : {}),
              ...(payload['status'] !== undefined ? { status: String(payload['status']) } : {}),
              ...(payload['limit'] !== undefined ? { limit: Number(payload['limit']) } : {}),
              ...(payload['offset'] !== undefined ? { offset: Number(payload['offset']) } : {}),
            });
            return { total, items: items.map(toDocumentJson) } as unknown as JsonValue;
          }
          case 'get_document_content': {
            const result = await service.documentContent(String(payload['documentId'] ?? ''), {
              ...(payload['offset'] !== undefined ? { offset: Number(payload['offset']) } : {}),
              ...(payload['limit'] !== undefined ? { limit: Number(payload['limit']) } : {}),
            });
            return {
              document: toDocumentJson(result.document),
              content: result.content,
              truncated: result.truncated,
              contentTrusted: false,
            } as unknown as JsonValue;
          }
          case 'search': {
            const outcome = await service.search({
              query: String(payload['query'] ?? ''),
              ...(payload['mode'] !== undefined ? { mode: String(payload['mode']) } : {}),
              ...(payload['topK'] !== undefined ? { topK: Number(payload['topK']) } : {}),
              signal,
            });
            return {
              query: outcome.query,
              mode: outcome.mode,
              degraded: outcome.degraded,
              results: outcome.results.map((hit) => ({
                documentId: hit.documentId,
                documentName: hit.documentName,
                content: hit.content,
                sectionPath: hit.sectionPath,
                lineStart: hit.lineStart,
                lineEnd: hit.lineEnd,
                score: hit.score,
              })),
            } as unknown as JsonValue;
          }
          case 'upload_file': {
            const receipt = await service.upload(
              {
                filename: String(payload['filename'] ?? ''),
                data: Buffer.from(String(payload['content'] ?? ''), 'utf-8'),
              },
              signal,
            );
            return {
              name: receipt.name,
              sourceId: receipt.sourceId,
              status: 'queued',
            } as unknown as JsonValue;
          }
          case 'get_config':
            return this.#require().settings as unknown as JsonValue;
          case 'update_config': {
            const moduleContext = this.#context;
            if (moduleContext === undefined) throw new Error('知识库模块未激活');
            // 存原始输入后经 loadSettings 归一化（clamp + 默认值合并）再落盘
            await moduleContext.config.set(CONFIG_KEY, (payload['settings'] ?? {}) as JsonValue);
            const normalized = await loadSettings(moduleContext.config);
            await saveSettings(moduleContext.config, normalized);
            await this.#swapServices(moduleContext);
            return this.#require().settings as unknown as JsonValue;
          }
          default:
            throw new Error(`未知的页面服务操作：${action}`);
        }
      });
  }
}

/** 公开文档 DTO（list_documents 工具）：error 防御性再脱敏，兼容历史数据中的绝对路径。 */
export function toDocumentInfo(document: Document): {
  id: string;
  name: string;
  status: string;
  error: string | null;
} {
  return {
    id: document.id,
    name: document.name,
    status: document.status,
    error: document.error === null ? null : safeMessage(document.error),
  };
}

function toDocumentJson(document: Document): JsonValue {
  return {
    id: document.id,
    sourceId: document.sourceId,
    relPath: document.relPath,
    name: document.name,
    status: document.status,
    error: document.error === null ? null : safeMessage(document.error),
    chunkCount: document.chunkCount,
    size: document.size,
    mtimeNs: document.mtimeNs.toString(),
    indexedAt: document.indexedAt,
  } as unknown as JsonValue;
}

function toSourceJson(source: Source): JsonValue {
  return {
    id: source.id,
    type: source.type,
    path: source.path,
    name: source.name,
    createdAt: source.createdAt,
    ignoreRules: source.ignoreRules,
  } as unknown as JsonValue;
}

/** 组合根入口：创建知识库运行时模块。 */
export function createKnowledgeRuntime(options: CreateKnowledgeRuntimeOptions = {}): RuntimeModule {
  const runtime = new KnowledgeRuntime(options);
  if (options.registerPageService) {
    options.registerPageService(runtime.pageService());
  }
  return runtime;
}

export type { SyncStatus, SearchMode };

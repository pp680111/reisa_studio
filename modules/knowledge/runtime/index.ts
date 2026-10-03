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
import { SyncService, type SyncStatus } from './sync.ts';
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
}

export type PageServiceInvoke = (action: string, input: JsonValue) => Promise<JsonValue>;

interface KnowledgeRuntimeServices {
  readonly settings: KnowledgeSettings;
  readonly database: MetadataDB;
  readonly store: ChunkStore;
  readonly service: KnowledgeBase;
  readonly sync: SyncService;
}

export class KnowledgeRuntime implements RuntimeModule {
  readonly id = 'knowledge';
  readonly version = '0.1.0';
  readonly protocolVersion = '1' as const;

  #context: ModuleContext | undefined;
  #services: KnowledgeRuntimeServices | undefined;

  async activate(context: ModuleContext): Promise<ModuleActivation> {
    this.#context = context;
    this.#services = await this.#initialize(context);
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
    if (services) {
      await services.sync.stop();
      services.database.close();
      await services.store.close();
    }
  }

  /** skb main.build_knowledge_base 的启动顺序：建表 → 指纹校验 → 开库 → 组装。 */
  async #initialize(context: ModuleContext): Promise<KnowledgeRuntimeServices> {
    const settings = await loadSettings(context.config);
    const dataDir = context.storage.dataDir;
    const database = new MetadataDB(join(dataDir, 'data.sqlite'));
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

    const store = await ChunkStore.open(indexDir, settings.embedding.dimensions);
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

    const sync = new SyncService({
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
      logger: context.logger,
    });

    await service.migrateUploadSources();
    await service.ensureUploadsSource();
    sync.start();
    return { settings, database, store, service, sync };
  }

  /** 配置变更后的就地重装配：停同步 → 关库与索引连接 → 按新配置重建（skb 启动时读配置的等价物）。 */
  async #reconfigure(): Promise<void> {
    const context = this.#context;
    if (context === undefined) return;
    const previous = this.#services;
    this.#services = undefined;
    if (previous) {
      await previous.sync.stop();
      previous.database.close();
      // 先释放 LanceDB 句柄再重初始化：指纹变更时 #initialize 需要 rm 整个索引目录
      await previous.store.close();
    }
    this.#services = await this.#initialize(context);
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
          const outcome = await this.#require().service.search({
            query: input.query,
            mode: input.mode ?? 'hybrid',
            topK: input.topK ?? 8,
          });
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
          const { items, total } = this.#require().service.listDocuments({
            limit: input.limit ?? 50,
            offset: input.offset ?? 0,
          });
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
          const { document, content, truncated } = await this.#require().service.documentContent(
            input.documentId,
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
          const receipt = await this.#require().service.upload({
            filename: input.filename,
            data: Buffer.from(input.content, 'utf-8'),
          });
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
    return async (action, input) => {
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
            ...(payload['sourceId'] !== undefined ? { sourceId: String(payload['sourceId']) } : {}),
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
          const receipt = await service.upload({
            filename: String(payload['filename'] ?? ''),
            data: Buffer.from(String(payload['content'] ?? ''), 'utf-8'),
          });
          return {
            name: receipt.name,
            sourceId: receipt.sourceId,
            status: 'queued',
          } as unknown as JsonValue;
        }
        case 'get_config':
          return this.#require().settings as unknown as JsonValue;
        case 'update_config': {
          const context = this.#context;
          if (context === undefined) throw new Error('知识库模块未激活');
          // 存原始输入后经 loadSettings 归一化（clamp + 默认值合并）再落盘
          await context.config.set(CONFIG_KEY, (payload['settings'] ?? {}) as JsonValue);
          const normalized = await loadSettings(context.config);
          await saveSettings(context.config, normalized);
          await this.#reconfigure();
          return this.#require().settings as unknown as JsonValue;
        }
        default:
          throw new Error(`未知的页面服务操作：${action}`);
      }
    };
  }
}

function toDocumentInfo(document: Document): {
  id: string;
  name: string;
  status: string;
  error: string | null;
} {
  return { id: document.id, name: document.name, status: document.status, error: document.error };
}

function toDocumentJson(document: Document): JsonValue {
  return {
    id: document.id,
    sourceId: document.sourceId,
    relPath: document.relPath,
    name: document.name,
    status: document.status,
    error: document.error,
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
  const runtime = new KnowledgeRuntime();
  if (options.registerPageService) {
    options.registerPageService(runtime.pageService());
  }
  return runtime;
}

export type { SyncStatus, SearchMode };

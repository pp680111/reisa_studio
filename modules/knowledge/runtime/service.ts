import type { ModuleLogger } from '@reisa/module-sdk';
import { existsSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { SUPPORTED_SUFFIXES } from './parsing.ts';
import { IgnoreRules } from './ignore.ts';
import {
  type Document,
  type LibraryStats,
  type MetadataDB,
  type Source,
  type SourceDocumentStats,
} from './db.ts';
import { ChunkStore, type SearchHit } from './store.ts';
import { DocumentExcludedError, SyncService, readDocumentText, safeMessage } from './sync.ts';
import { DEFAULT_SETTINGS } from './config.ts';
import type { Embedder } from './embedding.ts';

/**
 * 唯一应用层（迁移自 skb service.py）：来源、文档、检索与上传。
 * ServiceError.code 与 skb 保持一致，能力层负责映射到 SDK 错误码（迁移设计文档 §7.1）。
 */

const SUPPORTED_SUFFIX_TEXT = [...SUPPORTED_SUFFIXES].sort().join(', ');

export class ServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

export interface SearchOutcome {
  readonly query: string;
  readonly mode: string;
  readonly degraded: boolean;
  readonly results: SearchHit[];
}

export interface UploadReceipt {
  readonly name: string;
  readonly sourceId: string;
}

export interface KnowledgeBaseOptions {
  readonly uploadsPath: string;
  readonly database: MetadataDB;
  readonly store: ChunkStore;
  readonly embedder: Embedder | null;
  readonly sync: SyncService;
  /** 上传单文件大小上限（字节）；来自模块设置 uploadMaxBytes，缺省用默认设置。 */
  readonly uploadMaxBytes?: number;
  readonly logger?: ModuleLogger;
}

export class KnowledgeBase {
  readonly #uploadsPath: string;
  readonly #database: MetadataDB;
  readonly #store: ChunkStore;
  readonly #embedder: Embedder | null;
  readonly #sync: SyncService;
  readonly #uploadMaxBytes: number;
  readonly #logger: ModuleLogger | undefined;

  constructor(options: KnowledgeBaseOptions) {
    this.#uploadsPath = options.uploadsPath;
    this.#database = options.database;
    this.#store = options.store;
    this.#embedder = options.embedder;
    this.#sync = options.sync;
    this.#uploadMaxBytes = options.uploadMaxBytes ?? DEFAULT_SETTINGS.uploadMaxBytes;
    this.#logger = options.logger;
  }

  get sync(): SyncService {
    return this.#sync;
  }

  get store(): ChunkStore {
    return this.#store;
  }

  stats(): LibraryStats {
    return this.#database.stats();
  }

  sourceDocumentStats(): SourceDocumentStats[] {
    return this.#database.sourceDocumentStats();
  }

  /**
   * 检索（skb search 语义）：hybrid 降级全文并标记 degraded；vector 失败报 embedding_unavailable。
   * 有意偏差：skb 中"未配置 embedding + hybrid"会抛 ValueError（HTTP 500），
   * 与其 README 的降级承诺矛盾；迁移实现统一走降级路径，保证 Agent 检索能力始终可用。
   */
  async search(options: {
    query: string;
    mode?: string;
    topK?: number;
    /** 取消信号：中止向量请求（架构设计 §10.3）；全文检索为本地快查，不做中途取消。 */
    signal?: AbortSignal;
  }): Promise<SearchOutcome> {
    const mode = options.mode ?? 'hybrid';
    const topK = options.topK ?? 10;
    const query = options.query;
    const signal = options.signal;
    if (mode !== 'hybrid' && mode !== 'vector' && mode !== 'full_text') {
      throw new ServiceError('mode_unsupported', 'mode must be hybrid, vector, or full_text');
    }
    if (!query.trim()) {
      throw new ServiceError('query_empty', 'query must not be empty');
    }
    if (mode === 'full_text') {
      return this.#finish(
        query,
        mode,
        await this.#store.search({ queryText: query, queryVector: null, mode, limit: topK }),
      );
    }
    let queryVector: number[] | null = null;
    if (this.#embedder !== null) {
      try {
        const batch = await this.#embedder.embed([query], signal);
        queryVector = batch.vectors[0] ?? null;
      } catch (error) {
        // 取消优先于降级：已中止的检索不再转为全文降级结果（架构设计 §10.3）。
        signal?.throwIfAborted();
        if (mode === 'vector') {
          throw new ServiceError(
            'embedding_unavailable',
            String(error instanceof Error ? error.message : error),
          );
        }
        this.#logger?.warn('search_degraded', {
          code: error instanceof Error ? error.name : 'unknown',
        });
        return this.#finish(
          query,
          'full_text',
          await this.#store.search({
            queryText: query,
            queryVector: null,
            mode: 'full_text',
            limit: topK,
          }),
          true,
        );
      }
    } else {
      // 未配置 embedding：vector 直接不可用；hybrid 降级为全文（degraded）
      if (mode === 'vector') {
        throw new ServiceError('embedding_unavailable', 'Embedding service is not configured');
      }
      this.#logger?.warn('search_degraded', { code: 'not_configured' });
      return this.#finish(
        query,
        'full_text',
        await this.#store.search({
          queryText: query,
          queryVector: null,
          mode: 'full_text',
          limit: topK,
        }),
        true,
      );
    }
    return this.#finish(
      query,
      mode,
      await this.#store.search({ queryText: query, queryVector, mode, limit: topK }),
    );
  }

  #finish(query: string, mode: string, results: SearchHit[], degraded = false): SearchOutcome {
    return { query, mode, degraded, results };
  }

  async addSource(options: { path: string; name?: string; ignoreRules?: string }): Promise<Source> {
    const ignoreRules = options.ignoreRules ?? '';
    validateIgnoreRules(ignoreRules);
    const resolved = resolve(options.path);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new ServiceError(
        'source_path_invalid',
        'Source path does not exist or cannot be resolved',
      );
    }
    if (!info.isFile() && !info.isDirectory()) {
      throw new ServiceError(
        'source_path_invalid',
        'Source path must be a regular file or directory',
      );
    }
    if (this.#database.findSourceByPath(resolved) !== undefined) {
      throw new ServiceError('source_exists', 'This path is already registered');
    }
    if (info.isDirectory()) {
      for (const source of this.#database.listSources()) {
        if (nested(resolved, source.path) || nested(source.path, resolved)) {
          throw new ServiceError(
            'source_overlaps',
            'The path overlaps an already registered source',
          );
        }
      }
    }
    const source = this.#database.createSource({
      type: info.isFile() ? 'local_file' : 'local_dir',
      path: resolved,
      name: options.name ?? basename(resolved),
      ignoreRules,
    });
    this.#sync.wake();
    return source;
  }

  async updateSourceRules(sourceId: string, ignoreRules: string): Promise<Source> {
    if (this.#database.getSource(sourceId) === undefined) {
      throw new ServiceError('source_not_found', 'Source not found');
    }
    validateIgnoreRules(ignoreRules);
    this.#database.updateSourceRules(sourceId, ignoreRules);
    this.#sync.wake();
    const source = this.#database.getSource(sourceId);
    if (source === undefined) throw new ServiceError('source_not_found', 'Source not found');
    return source;
  }

  async removeSource(sourceId: string): Promise<Source> {
    const source = this.#database.getSource(sourceId);
    if (source === undefined) throw new ServiceError('source_not_found', 'Source not found');
    this.#sync.unwatch(source.id);
    await this.#store.deleteSource(source.id);
    this.#database.deleteSource(source.id);
    return source;
  }

  listSources(): Source[] {
    return this.#database.listSources();
  }

  getSource(sourceId: string): Source | undefined {
    return this.#database.getSource(sourceId);
  }

  listDocuments(options: { sourceId?: string; status?: string; limit?: number; offset?: number }): {
    items: Document[];
    total: number;
  } {
    return this.#database.listDocuments(options);
  }

  async submitForIndex(documentId: string): Promise<Document> {
    const document = this.#database.getDocument(documentId);
    if (document === undefined) {
      throw new ServiceError('document_not_found', 'Document not found');
    }
    if (this.#database.getSource(document.sourceId) === undefined) {
      throw new ServiceError('document_not_found', 'Document source is gone');
    }
    try {
      await this.#sync.indexDocument(documentId);
    } catch (error) {
      if (error instanceof DocumentExcludedError) {
        throw new ServiceError('document_excluded', '文档已被来源扫描规则排除');
      }
      if (error instanceof Error && /document not found/i.test(error.message)) {
        throw new ServiceError('document_not_found', 'Document file is gone');
      }
      throw error;
    }
    const refreshed = this.#database.getDocument(documentId);
    if (refreshed === undefined) {
      throw new ServiceError('document_not_found', 'Document file is gone');
    }
    return refreshed;
  }

  /** 解析后的原文窗口（skb document_content 语义）：content 恒按不可信数据处理。 */
  async documentContent(
    documentId: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<{ document: Document; content: string; truncated: boolean }> {
    const document = this.#database.getDocument(documentId);
    if (document === undefined) {
      throw new ServiceError('document_not_found', 'Document not found');
    }
    const source = this.#database.getSource(document.sourceId);
    if (source === undefined) {
      throw new ServiceError('document_not_found', 'Document source is gone');
    }
    let path = source.path;
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new ServiceError('document_unreadable', 'Document file is gone');
    }
    if (info.isDirectory()) path = join(path, document.relPath);
    let parsed;
    try {
      parsed = await readDocumentText(path);
    } catch (error) {
      // fs 错误消息通常含本机绝对路径：公开面只返回脱敏后的类别与文件名
      throw new ServiceError('document_unreadable', safeMessage(error));
    }
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20_000;
    const content = parsed.content;
    const window = content.slice(offset, offset + limit);
    return { document, content: window, truncated: offset + limit < content.length };
  }

  /** 上传单篇文档落入内置 uploads 来源：同名覆盖，后台自动重新索引。 */
  async upload(
    options: { filename: string; data: Buffer },
    signal?: AbortSignal,
  ): Promise<UploadReceipt> {
    const suffix =
      basename(options.filename)
        .toLowerCase()
        .match(/\.[^.]+$/)?.[0] ?? '';
    if (!SUPPORTED_SUFFIXES.has(suffix)) {
      throw new ServiceError(
        'format_unsupported',
        `Only ${SUPPORTED_SUFFIX_TEXT} uploads are accepted`,
      );
    }
    if (!options.data.length || !options.data.toString('utf8').trim()) {
      throw new ServiceError('upload_empty', 'Uploaded content must not be empty');
    }
    // 取消检查在首个副作用（建目录/写文件）之前。
    signal?.throwIfAborted();
    // 大小上限在写盘之前校验（字节语义，恰好等于上限放行）；页面与 Agent 上传共用此入口。
    if (options.data.byteLength > this.#uploadMaxBytes) {
      throw new ServiceError(
        'upload_too_large',
        `上传内容 ${options.data.byteLength} 字节，超过大小上限 ${this.#uploadMaxBytes} 字节`,
      );
    }
    const name = options.filename.replaceAll('\\', '/').split('/').pop()?.trim() || 'upload';
    const source = await this.ensureUploadsSource();
    await writeFile(join(this.#uploadsPath, name), options.data);
    this.#sync.wake();
    return { name, sourceId: source.id };
  }

  /** uploads 目录是一个内置目录型来源；删除后下次上传或重启自动恢复（skb 语义）。 */
  async ensureUploadsSource(): Promise<Source> {
    await mkdir(this.#uploadsPath, { recursive: true });
    const resolved = resolve(this.#uploadsPath);
    const existing = this.#database.findSourceByPath(resolved);
    if (existing !== undefined) return existing;
    return this.#database.createSource({ type: 'local_dir', path: resolved, name: 'uploads' });
  }

  /** 旧版逐文件 upload 来源折入 uploads 目录来源（skb migrate_upload_sources 语义）。 */
  async migrateUploadSources(): Promise<void> {
    for (const source of this.#database.listSources()) {
      if (source.type !== 'upload') continue;
      this.#sync.unwatch(source.id);
      const target = join(this.#uploadsPath, source.name);
      try {
        if (existsSync(source.path) && !existsSync(target)) {
          await rename(source.path, target);
        }
      } catch {
        this.#logger?.warn('upload_migration_rename_failed', { sourceId: source.id });
      }
      await this.#store.deleteSource(source.id);
      this.#database.deleteSource(source.id);
      this.#logger?.info('upload_source_migrated', { sourceId: source.id });
    }
  }
}

function validateIgnoreRules(rules: string): void {
  try {
    new IgnoreRules(rules);
  } catch (error) {
    throw new ServiceError(
      'ignore_rules_invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function nested(parent: string, child: string): boolean {
  if (resolve(parent) === resolve(child)) return false;
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** uploads 目录的约定位置：<模块 dataDir>/files/uploads（§7.3 存储映射）。 */
export function uploadsPathFor(dataDir: string): string {
  return join(dataDir, 'files', 'uploads');
}

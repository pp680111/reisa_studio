import type { ModuleLogger } from '@reisa/module-sdk';
import { existsSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseDocument, isSupportedDocument } from './parsing.ts';
import { RecursiveChunker, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS } from './chunking.ts';
import { IgnoreRules } from './ignore.ts';
import { scanDirectory, type FileSnapshot } from './scanner.ts';
import {
  documentIdentity,
  type Document,
  type DocumentInput,
  type MetadataDB,
  type Source,
} from './db.ts';
import { ChunkStore, type ChunkRecord } from './store.ts';
import type { Embedder } from './embedding.ts';
import { ChangeWatcher } from './watcher.ts';

/**
 * 后台对账/索引循环（迁移自 skb sync.py）。
 * 语义基准（迁移设计文档 §4.1）：watcher 唤醒 + 周期全量对账兜底、防抖合并、
 * 增量判断 size+mtime_ns、内容哈希不变保留旧向量、manual_required、单飞行锁。
 */

export const MANUAL_REQUIRED = 'manual_required';

export class DocumentExcludedError extends Error {
  readonly relPath: string;
  constructor(relPath: string) {
    super(`文档已被来源扫描规则排除：${relPath}`);
    this.name = 'DocumentExcludedError';
    this.relPath = relPath;
  }
}

export interface SyncStatus {
  readonly running: boolean;
  readonly pending: boolean;
  readonly runs: number;
  readonly intervalSeconds: number;
  readonly lastRunAt: string | null;
  readonly lastRunSeconds: number | null;
}

/** 串行化执行：手动索引与对账共用一把锁，不会交错（skb asyncio.Lock 语义）。 */
class AsyncMutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export interface SyncServiceOptions {
  readonly database: MetadataDB;
  readonly store: ChunkStore;
  readonly embedder: Embedder | null;
  readonly intervalSeconds: number;
  readonly debounceSeconds: number;
  readonly autoIndexMaxBytes?: number;
  readonly maxTokens?: number;
  readonly overlapTokens?: number;
  readonly logger?: ModuleLogger;
}

export class SyncService {
  readonly #database: MetadataDB;
  readonly #store: ChunkStore;
  readonly #embedder: Embedder | null;
  readonly #intervalSeconds: number;
  readonly #debounceSeconds: number;
  readonly #autoIndexMaxBytes: number;
  readonly #chunker: RecursiveChunker;
  readonly #logger: ModuleLogger | undefined;
  readonly #mutex = new AsyncMutex();
  readonly #wakeResolvers = new Set<() => void>();
  #watcher: ChangeWatcher | undefined;
  #loop: Promise<void> | undefined;
  #stopping = false;
  #running = false;
  #runs = 0;
  #lastRunAt: string | null = null;
  #lastRunSeconds: number | null = null;

  constructor(options: SyncServiceOptions) {
    this.#database = options.database;
    this.#store = options.store;
    this.#embedder = options.embedder;
    this.#intervalSeconds = options.intervalSeconds;
    this.#debounceSeconds = options.debounceSeconds;
    this.#autoIndexMaxBytes = options.autoIndexMaxBytes ?? 5 * 1024 * 1024;
    this.#chunker = new RecursiveChunker({
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      overlapTokens: options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    });
    this.#logger = options.logger;
  }

  start(): void {
    if (this.#loop !== undefined) return;
    this.#stopping = false;
    this.#watcher = new ChangeWatcher(() => this.wake());
    this.#loop = this.#runForever();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const loop = this.#loop;
    this.#loop = undefined;
    this.wake();
    await loop;
    await this.#watcher?.stop();
    this.#watcher = undefined;
  }

  /** 请求一次对账；可在任何上下文调用（skb wake 语义）。 */
  wake(): void {
    for (const resolveWake of [...this.#wakeResolvers]) resolveWake();
  }

  unwatch(sourceId: string): void {
    this.#watcher?.unwatch(sourceId);
  }

  status(): SyncStatus {
    return {
      running: this.#running,
      pending: this.#wakeResolvers.size > 0,
      runs: this.#runs,
      intervalSeconds: this.#intervalSeconds,
      lastRunAt: this.#lastRunAt,
      lastRunSeconds: this.#lastRunSeconds,
    };
  }

  async reconcileAll(): Promise<void> {
    this.#wakeResolvers.clear();
    const started = Date.now();
    this.#running = true;
    try {
      await this.#mutex.run(async () => {
        for (const source of this.#database.listSources()) {
          try {
            await this.reconcileSource(source);
          } catch (error) {
            this.#logger?.error('source_reconciliation_failed', {
              sourceId: source.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          this.#watcher?.watchExisting(source.id, source.path);
        }
        if ((await this.#store.chunkCount()) > 0) {
          await this.#store.ensureIndexes();
        }
      });
    } finally {
      this.#running = false;
      this.#runs += 1;
      this.#lastRunSeconds = (Date.now() - started) / 1000;
      this.#lastRunAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  }

  async reconcileSource(source: Source): Promise<void> {
    const ignore = new IgnoreRules(source.ignoreRules);
    const probed = await probeTarget(source.path, ignore);
    if (!probed.alive) {
      this.unwatch(source.id);
      for (const document of this.#database.documentsForSource(source.id)) {
        await this.#removeDocument(document, 'source path is gone');
      }
      return;
    }
    const known = new Map(
      this.#database.documentsForSource(source.id).map((document) => [document.relPath, document]),
    );
    const seen = new Set<string>();
    for (const snapshot of probed.snapshots) {
      seen.add(snapshot.relPath);
      const knownDocument = known.get(snapshot.relPath);
      if (knownDocument !== undefined) {
        const unchanged =
          knownDocument.size === snapshot.size && knownDocument.mtimeNs === snapshot.mtimeNs;
        if (unchanged && knownDocument.status === 'indexed') continue;
        if (
          knownDocument.status === MANUAL_REQUIRED &&
          unchanged &&
          this.#exceedsAutoLimit(snapshot.size)
        ) {
          // 仍然超限且未变化：继续等待手动提交，不每轮重复写状态
          continue;
        }
      }
      await this.#indexFile(source, probed.scanRoot, snapshot);
    }
    for (const [relPath, document] of known) {
      if (!seen.has(relPath)) {
        await this.#removeDocument(
          document,
          ignore.excludes(relPath) ? 'excluded by scan rules' : 'file deleted',
        );
      }
    }
  }

  /** 请求式单篇索引：绕过大小门槛但不绕过排除规则；与对账互斥（skb index_document 语义）。 */
  async indexDocument(documentId: string): Promise<void> {
    await this.#mutex.run(async () => {
      const document = this.#database.getDocument(documentId);
      const source = document ? this.#database.getSource(document.sourceId) : undefined;
      if (document === undefined || source === undefined) {
        throw new Error('document not found');
      }
      if (new IgnoreRules(source.ignoreRules).excludes(document.relPath)) {
        throw new DocumentExcludedError(document.relPath);
      }
      const located = locateDocument(source.path, document.relPath);
      let info;
      try {
        info = await stat(located.path, { bigint: true });
      } catch (error) {
        // 抛出前经 safeMessage 去路径（保留错误类别与文件名）；完整原始错误留模块日志
        this.#logDocumentFailure('document_stat_failed', documentId, document.relPath, error);
        throw new Error(safeMessage(error));
      }
      await this.#indexFile(
        source,
        located.scanRoot,
        { relPath: document.relPath, size: Number(info.size), mtimeNs: info.mtimeNs },
        document.name,
        { force: true },
      );
    });
  }

  async #indexFile(
    source: Source,
    root: string,
    snapshot: FileSnapshot,
    displayName?: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const path = join(root, snapshot.relPath);
    const documentId = documentIdentity(source.id, snapshot.relPath);
    const indexedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    let base: DocumentInput = {
      id: documentId,
      sourceId: source.id,
      relPath: snapshot.relPath,
      name: displayName ?? basename(snapshot.relPath),
      contentHash: null,
      status: 'error',
      error: null,
      chunkCount: 0,
      size: snapshot.size,
      mtimeNs: snapshot.mtimeNs,
      indexedAt: null,
    };

    const recordFailure = (message: string): void => {
      this.#database.upsertDocument({ ...base, status: 'error', error: message });
    };

    if (this.#embedder === null) {
      recordFailure('Embedding service is not configured');
      return;
    }
    if (options.force !== true && this.#exceedsAutoLimit(snapshot.size)) {
      await this.#deferToManual(base, snapshot);
      return;
    }
    let parsed;
    try {
      parsed = await parseDocument(path);
    } catch (error) {
      this.#logDocumentFailure('document_parse_failed', documentId, snapshot.relPath, error);
      recordFailure(safeMessage(error));
      return;
    }
    base = { ...base, contentHash: parsed.contentHash, name: displayName ?? parsed.displayName };
    const existing = this.#database.getDocument(documentId);
    if (
      existing !== undefined &&
      existing.status === 'indexed' &&
      existing.contentHash === parsed.contentHash
    ) {
      // 内容未变（仅触碰时间戳）：保留旧向量，不重新嵌入
      this.#database.upsertDocument({
        ...base,
        status: 'indexed',
        error: null,
        chunkCount: existing.chunkCount,
        indexedAt: existing.indexedAt,
      });
      return;
    }
    const chunks = this.#chunker.chunk(parsed, documentId);
    if (chunks.length === 0) {
      this.#database.upsertDocument({ ...base, status: 'indexed', error: null, indexedAt });
      return;
    }
    let vectors: number[][];
    try {
      const batch = await this.#embedder.embed(chunks.map((chunk) => chunk.content));
      vectors = batch.vectors;
    } catch (error) {
      this.#logDocumentFailure('document_embed_failed', documentId, snapshot.relPath, error);
      recordFailure(safeMessage(error));
      return;
    }
    const records: ChunkRecord[] = chunks.map((chunk, index) => ({
      chunkId: chunk.chunkId,
      documentId,
      sourceId: source.id,
      ordinal: chunk.ordinal,
      content: chunk.content,
      contentHash: chunk.contentHash,
      tokenCount: chunk.tokenCount,
      documentName: base.name,
      sectionPath: chunk.sectionPath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      mimeType: parsed.mimeType,
      modifiedAt: new Date(),
      vector: vectors[index] ?? [],
    }));
    await this.#store.replaceDocument(records);
    this.#database.upsertDocument({
      ...base,
      status: 'indexed',
      error: null,
      chunkCount: records.length,
      indexedAt,
    });
  }

  #exceedsAutoLimit(size: number): boolean {
    // autoIndexMaxBytes 为 0 表示关闭门槛
    return this.#autoIndexMaxBytes > 0 && size > this.#autoIndexMaxBytes;
  }

  /** 诊断级完整错误只写模块日志；公开面（document.error）由调用方另行脱敏。 */
  #logDocumentFailure(
    event: string,
    documentId: string,
    relPath: string,
    error: unknown,
  ): void {
    this.#logger?.error(event, {
      documentId,
      relPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  async #deferToManual(base: DocumentInput, snapshot: FileSnapshot): Promise<void> {
    this.#logger?.info('document_needs_manual_submit', {
      documentId: base.id,
      relPath: snapshot.relPath,
      size: snapshot.size,
      limit: this.#autoIndexMaxBytes,
    });
    // 更早版本的旧向量一并清除：索引只保留人工提交的内容
    await this.#store.deleteDocument(base.id);
    this.#database.upsertDocument({
      ...base,
      status: MANUAL_REQUIRED,
      error:
        `file is ${snapshot.size} bytes, above the ${this.#autoIndexMaxBytes}` +
        '-byte auto-index limit; submit it for indexing manually',
      chunkCount: 0,
      indexedAt: null,
    });
  }

  async #removeDocument(document: Document, reason: string): Promise<void> {
    this.#logger?.info('document_removed', {
      documentId: document.id,
      relPath: document.relPath,
      reason,
    });
    await this.#store.deleteDocument(document.id);
    this.#database.deleteDocument(document.id);
  }

  async #runForever(): Promise<void> {
    while (!this.#stopping) {
      await this.#waitOrTimeout(this.#intervalSeconds);
      if (this.#stopping) break;
      this.#wakeResolvers.clear();
      await sleep(this.#debounceSeconds);
      this.#wakeResolvers.clear();
      // 防抖期间被停止：不再开启新一轮对账（架构设计 §10.2，stop 后拒绝新工作）。
      if (this.#stopping) break;
      await this.reconcileAll();
    }
  }

  #waitOrTimeout(intervalSeconds: number): Promise<void> {
    return new Promise((resolveWake) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.#wakeResolvers.delete(finish);
        resolveWake();
      };
      const timer = setTimeout(finish, intervalSeconds * 1000);
      if (timer.unref) timer.unref();
      this.#wakeResolvers.add(finish);
    });
  }
}

/** 错误文案中的路径字符集：到空白、引号或闭合标点为止（路径中不会出现这些字符）。 */
const PATH_CHAR = "[^\\s'\"<>|*，。）)：；]";

/**
 * 错误文案里的文件系统路径模式：Windows 盘符、UNC 与 POSIX 绝对路径。
 * 盘符模式带负向断言（前面不能是字母），避免把 http:// 等 URL 误判成路径。
 */
const FS_PATH_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?<![A-Za-z])[A-Za-z]:[\\\\/]${PATH_CHAR}*`, 'g'),
  new RegExp(`\\\\\\\\${PATH_CHAR}+(?:[\\\\/]${PATH_CHAR}+)+`, 'g'),
  new RegExp(`(?<=^|[\\s'"（(，；])/${PATH_CHAR}+`, 'g'),
];

/** 路径只保留最后一段（文件名或末级目录名），目录结构不进入公开文案。 */
function lastPathSegment(path: string): string {
  const stripped = path.replaceAll('\\', '/').replace(/[\\\\/]+$/, '');
  const index = stripped.lastIndexOf('/');
  return index >= 0 ? stripped.slice(index + 1) : stripped;
}

/**
 * 错误消息公开化（skb _safe_message 迁移强化版）：NFKC 归一化 + 剔除文件系统路径
 * （保留错误类别与文件名，不含目录）+ 300 字符截断；保证写入 document.error
 * 与公开 DTO 的文案不含本机绝对路径。完整原始错误由调用方写模块日志（架构设计 §10.3）。
 */
export function safeMessage(error: unknown): string {
  const normalized = (error instanceof Error ? error.message : String(error)).normalize('NFKC');
  let message = normalized;
  for (const pattern of FS_PATH_PATTERNS) {
    message = message.replace(pattern, lastPathSegment);
  }
  return message ? message.slice(0, 300) : error instanceof Error ? error.name : 'Error';
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, seconds * 1000));
}

/** 解析文档的文件路径与扫描根（skb _locate_document：单文件来源的扫描根是父目录）。 */
function locateDocument(root: string, relPath: string): { path: string; scanRoot: string } {
  let rootIsDirectory = false;
  try {
    rootIsDirectory = existsSync(root) && statSync(root).isDirectory();
  } catch {
    // stat 竞态失败按非目录处理：后续 stat 会以脱敏后的错误失败
    rootIsDirectory = false;
  }
  if (rootIsDirectory) {
    return { path: join(root, relPath), scanRoot: root };
  }
  return { path: root, scanRoot: dirname(root) };
}

interface ProbeResult {
  readonly alive: boolean;
  readonly scanRoot: string;
  readonly isDirectory: boolean;
  readonly snapshots: FileSnapshot[];
}

async function probeTarget(rootPath: string, ignore: IgnoreRules): Promise<ProbeResult> {
  let info;
  try {
    info = await stat(rootPath, { bigint: true });
  } catch {
    return { alive: false, scanRoot: rootPath, isDirectory: false, snapshots: [] };
  }
  if (info.isFile()) {
    // 单文件来源：rel_path = 文件名，扫描根 = 父目录（skb _probe_target 语义）
    const name = basename(resolve(rootPath));
    const snapshots =
      isSupportedDocument(name) && !ignore.excludes(name)
        ? [
            {
              relPath: name,
              size: Number(info.size),
              mtimeNs: info.mtimeNs,
            },
          ]
        : [];
    return { alive: true, scanRoot: dirname(resolve(rootPath)), isDirectory: false, snapshots };
  }
  const snapshots = await scanDirectory(rootPath, ignore);
  return { alive: true, scanRoot: rootPath, isDirectory: true, snapshots };
}

/** 文档正文按 section 拼接（service.document_content 共用）。 */
export async function readDocumentText(path: string): Promise<{
  content: string;
  contentHash: string;
  displayName: string;
  mimeType: string;
}> {
  const parsed = await parseDocument(path);
  return {
    content: parsed.sections.map((section) => section.content).join('\n'),
    contentHash: parsed.contentHash,
    displayName: parsed.displayName,
    mimeType: parsed.mimeType,
  };
}

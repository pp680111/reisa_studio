import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite 元数据存储（迁移自 skb db.py）：sources / documents / meta 三张表，
 * 文件系统本身才是事实来源。mtime_ns 为纳秒整数（超出 double 精度），读取用 bigint。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ignore_rules TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    name TEXT NOT NULL,
    content_hash TEXT,
    status TEXT NOT NULL,
    error TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ns INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source_id, rel_path)
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embedding_calls (
    id TEXT PRIMARY KEY,
    triggered_at TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    round_id TEXT NOT NULL DEFAULT '',
    batch_index INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    text_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    document_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    document_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embedding_calls_time ON embedding_calls (triggered_at);

CREATE TABLE IF NOT EXISTS embedding_call_items (
    call_id TEXT NOT NULL,
    text_index INTEGER NOT NULL,
    chunk_id TEXT,
    ordinal INTEGER,
    content_hash TEXT,
    content_preview TEXT,
    token_count INTEGER,
    section_path TEXT,
    line_start INTEGER,
    line_end INTEGER
);
CREATE INDEX IF NOT EXISTS idx_embedding_call_items_call ON embedding_call_items (call_id);
`;

export const EMBEDDING_IDENTITY_KEY = 'embedding_identity';

/** meta 表中记录当前向量由哪套 embedding 配置产生；指纹变更触发全量重建。 */

export interface Source {
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly name: string;
  readonly createdAt: string;
  readonly ignoreRules: string;
}

export interface Document {
  readonly id: string;
  readonly sourceId: string;
  readonly relPath: string;
  readonly name: string;
  readonly contentHash: string | null;
  readonly status: string;
  readonly error: string | null;
  readonly chunkCount: number;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly indexedAt: string | null;
  /** 同一文件版本连续自动索引失败次数；成功、文件变化或手动提交后清零。 */
  readonly retryCount: number;
}

export interface LibraryStats {
  readonly sources: number;
  readonly documents: number;
  readonly indexedDocuments: number;
  readonly failedDocuments: number;
}

export interface SourceDocumentStats {
  readonly sourceId: string;
  readonly documents: number;
  readonly indexedDocuments: number;
  readonly failedDocuments: number;
  readonly manualRequiredDocuments: number;
}

export interface DocumentInput {
  readonly id: string;
  readonly sourceId: string;
  readonly relPath: string;
  readonly name: string;
  readonly contentHash: string | null;
  readonly status: string;
  readonly error: string | null;
  readonly chunkCount: number;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly indexedAt: string | null;
  readonly retryCount: number;
}

// ---- embedding 调用记录（设计文档 knowledge-embedding-call-log.md）----

export type EmbeddingCallStatus = 'success' | 'failed';

export interface EmbeddingCallInput {
  readonly id: string;
  readonly triggeredAt: string;
  readonly status: EmbeddingCallStatus;
  readonly model: string;
  /** 同一轮 embed() 调用的唯一标识（一次索引可能切多个子批、各子批可能重试）。 */
  readonly roundId: string;
  /** 子批序号（0 起）。 */
  readonly batchIndex: number;
  /** 该子批内的尝试序号（0 起；重试递增）。 */
  readonly attempt: number;
  readonly textCount: number;
  readonly tokenCount: number | null;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly documentId: string;
  readonly relPath: string;
  readonly documentName: string;
}

export interface EmbeddingCallItemInput {
  readonly callId: string;
  readonly textIndex: number;
  readonly chunkId: string | null;
  readonly ordinal: number | null;
  readonly contentHash: string | null;
  readonly contentPreview: string | null;
  readonly tokenCount: number | null;
  readonly sectionPath: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

/** 读回类型与写入同形（无 bigint 等转换差异），共用同一接口。 */
export type EmbeddingCall = EmbeddingCallInput;
export type EmbeddingCallItem = EmbeddingCallItemInput;

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Python uuid.NAMESPACE_URL
const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** 与 Python `uuid.uuid5(NAMESPACE_URL, name).hex` 一致的 UUID v5（SHA-1）。 */
export function documentIdentity(sourceId: string, relPath: string): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(NAMESPACE_URL.replaceAll('-', ''), 'hex'));
  hash.update(`${sourceId}:${relPath}`, 'utf8');
  const bytes = hash.digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 32);
}

interface SourceRow {
  id: string;
  type: string;
  path: string;
  name: string;
  created_at: string;
  ignore_rules: string;
}

interface DocumentRow {
  id: string;
  source_id: string;
  rel_path: string;
  name: string;
  content_hash: string | null;
  status: string;
  error: string | null;
  chunk_count: number | bigint;
  size: number;
  mtime_ns: number | bigint;
  indexed_at: string | null;
  retry_count: number | bigint;
}

interface EmbeddingCallRow {
  id: string;
  triggered_at: string;
  status: string;
  model: string;
  round_id: string;
  batch_index: number | bigint;
  attempt: number | bigint;
  text_count: number | bigint;
  token_count: number | bigint | null;
  duration_ms: number | bigint;
  error_code: string | null;
  error_message: string | null;
  document_id: string;
  rel_path: string;
  document_name: string;
}

interface EmbeddingCallItemRow {
  call_id: string;
  text_index: number | bigint;
  chunk_id: string | null;
  ordinal: number | bigint | null;
  content_hash: string | null;
  content_preview: string | null;
  token_count: number | bigint | null;
  section_path: string | null;
  line_start: number | bigint | null;
  line_end: number | bigint | null;
}

function embeddingCallFromRow(row: EmbeddingCallRow): EmbeddingCall {
  return {
    id: row.id,
    triggeredAt: row.triggered_at,
    status: row.status as EmbeddingCallStatus,
    model: row.model,
    roundId: row.round_id,
    batchIndex: Number(row.batch_index),
    attempt: Number(row.attempt),
    textCount: Number(row.text_count),
    tokenCount: row.token_count === null ? null : Number(row.token_count),
    durationMs: Number(row.duration_ms),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    documentId: row.document_id,
    relPath: row.rel_path,
    documentName: row.document_name,
  };
}

function embeddingCallItemFromRow(row: EmbeddingCallItemRow): EmbeddingCallItem {
  return {
    callId: row.call_id,
    textIndex: Number(row.text_index),
    chunkId: row.chunk_id,
    ordinal: row.ordinal === null ? null : Number(row.ordinal),
    contentHash: row.content_hash,
    contentPreview: row.content_preview,
    tokenCount: row.token_count === null ? null : Number(row.token_count),
    sectionPath: row.section_path,
    lineStart: row.line_start === null ? null : Number(row.line_start),
    lineEnd: row.line_end === null ? null : Number(row.line_end),
  };
}

function sourceFromRow(row: SourceRow): Source {
  return {
    id: row.id,
    type: row.type,
    path: row.path,
    name: row.name,
    createdAt: row.created_at,
    ignoreRules: row.ignore_rules,
  };
}

function documentFromRow(row: DocumentRow): Document {
  return {
    id: row.id,
    sourceId: row.source_id,
    relPath: row.rel_path,
    name: row.name,
    contentHash: row.content_hash,
    status: row.status,
    error: row.error,
    chunkCount: Number(row.chunk_count),
    size: Number(row.size),
    mtimeNs: BigInt(row.mtime_ns),
    indexedAt: row.indexed_at,
    retryCount: Number(row.retry_count),
  };
}

/**
 * 各表必须存在的列。userData 里可能残留旧版应用（如 git 93577ee 的知识库原型）创建的
 * 同名表——`CREATE TABLE IF NOT EXISTS` 对其无效，后续查询会报"no such column"。
 * 建表前校验形状：不兼容的旧表改名保留（不静默丢弃数据），再按当前 Schema 重建。
 */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  sources: ['id', 'type', 'path', 'name', 'created_at'],
  documents: ['id', 'source_id', 'rel_path', 'status', 'size', 'mtime_ns'],
  meta: ['key', 'value'],
};

function quarantineForeignTables(db: DatabaseSync): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (info.length === 0) continue; // 表不存在，SCHEMA 会创建
    const names = new Set(info.map((column) => column.name));
    if (required.every((column) => names.has(column))) continue;
    const archive = `${table}_legacy_${Date.now()}`;
    db.exec(`ALTER TABLE ${table} RENAME TO ${archive}`);
    console.warn(
      `[knowledge] 检测到不兼容的旧表 ${table}（缺少 ${required.filter((c) => !names.has(c)).join(', ')}），` +
        `已改名为 ${archive} 保留，并按当前 Schema 重建。确认不再需要后可手动删除归档表。`,
    );
  }
}

export class MetadataDB {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // 同步 API 天然串行执行，无需 skb 的跨线程 RLock
    this.#db.exec('PRAGMA journal_mode=WAL');
    quarantineForeignTables(this.#db);
    this.#db.exec(SCHEMA);
    // 老库迁移：skb 旧数据库的 sources 表没有 ignore_rules 列
    const columns = this.#db.prepare('PRAGMA table_info(sources)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'ignore_rules')) {
      this.#db.exec("ALTER TABLE sources ADD COLUMN ignore_rules TEXT NOT NULL DEFAULT ''");
    }
    // 老库迁移：既有 documents 表没有 retry_count 列（错误重试上限）
    const documentColumns = this.#db.prepare('PRAGMA table_info(documents)').all() as {
      name: string;
    }[];
    if (!documentColumns.some((column) => column.name === 'retry_count')) {
      this.#db.exec('ALTER TABLE documents ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    }
    // 老库迁移：调用记录表缺轮次/批次/尝试列（记录粒度从 embed() 级改为接口请求级）。
    // 已存在的旧表 CREATE TABLE IF NOT EXISTS 不会补列，插入时报 "no such column"
    const callColumns = this.#db.prepare('PRAGMA table_info(embedding_calls)').all() as {
      name: string;
    }[];
    const callColumnNames = new Set(callColumns.map((column) => column.name));
    if (!callColumnNames.has('round_id')) {
      this.#db.exec("ALTER TABLE embedding_calls ADD COLUMN round_id TEXT NOT NULL DEFAULT ''");
    }
    if (!callColumnNames.has('batch_index')) {
      this.#db.exec(
        'ALTER TABLE embedding_calls ADD COLUMN batch_index INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!callColumnNames.has('attempt')) {
      this.#db.exec('ALTER TABLE embedding_calls ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0');
    }
  }

  /** 历史上被 quarantine 改名保留的旧表（诊断用）。 */
  listLegacyTables(): string[] {
    const rows = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_legacy_*'")
      .all() as unknown as { name: string }[];
    return rows.map((row) => row.name);
  }

  close(): void {
    this.#db.close();
  }

  createSource(input: { type: string; path: string; name: string; ignoreRules?: string }): Source {
    const source: Source = {
      id: crypto.randomUUID().replaceAll('-', ''),
      type: input.type,
      path: input.path,
      name: input.name,
      createdAt: utcNow(),
      ignoreRules: input.ignoreRules ?? '',
    };
    this.#db
      .prepare(
        'INSERT INTO sources (id, type, path, name, created_at, ignore_rules) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(source.id, source.type, source.path, source.name, source.createdAt, source.ignoreRules);
    return source;
  }

  updateSourceRules(sourceId: string, ignoreRules: string): void {
    this.#db.prepare('UPDATE sources SET ignore_rules = ? WHERE id = ?').run(ignoreRules, sourceId);
  }

  getSource(sourceId: string): Source | undefined {
    const row = this.#db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as
      SourceRow | undefined;
    return row ? sourceFromRow(row) : undefined;
  }

  listSources(): Source[] {
    const rows = this.#db
      .prepare('SELECT * FROM sources ORDER BY created_at, id')
      .all() as unknown as SourceRow[];
    return rows.map(sourceFromRow);
  }

  findSourceByPath(path: string): Source | undefined {
    const row = this.#db.prepare('SELECT * FROM sources WHERE path = ?').get(path) as
      SourceRow | undefined;
    return row ? sourceFromRow(row) : undefined;
  }

  deleteSource(sourceId: string): void {
    this.#db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
    this.#db.prepare('DELETE FROM documents WHERE source_id = ?').run(sourceId);
  }

  upsertDocument(document: DocumentInput): void {
    this.#db
      .prepare(
        `INSERT INTO documents (
            id, source_id, rel_path, name, content_hash, status, error,
            chunk_count, size, mtime_ns, indexed_at, retry_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            content_hash = excluded.content_hash,
            status = excluded.status,
            error = excluded.error,
            chunk_count = excluded.chunk_count,
            size = excluded.size,
            mtime_ns = excluded.mtime_ns,
            indexed_at = excluded.indexed_at,
            retry_count = excluded.retry_count`,
      )
      .run(
        document.id,
        document.sourceId,
        document.relPath,
        document.name,
        document.contentHash,
        document.status,
        document.error,
        document.chunkCount,
        document.size,
        document.mtimeNs,
        document.indexedAt,
        document.retryCount,
      );
  }

  getDocument(documentId: string): Document | undefined {
    const statement = this.#db.prepare('SELECT * FROM documents WHERE id = ?');
    statement.setReadBigInts(true);
    const row = statement.get(documentId) as DocumentRow | undefined;
    return row ? documentFromRow(row) : undefined;
  }

  listDocuments(
    options: {
      sourceId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): { items: Document[]; total: number } {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (options.sourceId !== undefined) {
      clauses.push('source_id = ?');
      parameters.push(options.sourceId);
    }
    if (options.status !== undefined) {
      clauses.push('status = ?');
      parameters.push(options.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM documents ${where}`)
      .get(...parameters) as { total: number | bigint };
    const statement = this.#db.prepare(
      `SELECT * FROM documents ${where} ORDER BY rel_path LIMIT ? OFFSET ?`,
    );
    statement.setReadBigInts(true);
    const rows = statement.all(...parameters, limit, offset) as unknown as DocumentRow[];
    return { items: rows.map(documentFromRow), total: Number(totalRow.total) };
  }

  documentsForSource(sourceId: string): Document[] {
    const statement = this.#db.prepare('SELECT * FROM documents WHERE source_id = ?');
    statement.setReadBigInts(true);
    const rows = statement.all(sourceId) as unknown as DocumentRow[];
    return rows.map(documentFromRow);
  }

  deleteDocument(documentId: string): void {
    this.#db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
  }

  deleteAllDocuments(): void {
    this.#db.exec('DELETE FROM documents');
  }

  getSetting(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.#db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  // ---- embedding 调用记录（仅文档索引调用；旁路数据，失败由调用方吞掉）----

  /** 单事务写入一条调用记录及其 chunk 明细。 */
  insertEmbeddingCall(call: EmbeddingCallInput, items: readonly EmbeddingCallItemInput[]): void {
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare(
          `INSERT INTO embedding_calls (
              id, triggered_at, status, model, round_id, batch_index, attempt,
              text_count, token_count, duration_ms, error_code, error_message,
              document_id, rel_path, document_name
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          call.id,
          call.triggeredAt,
          call.status,
          call.model,
          call.roundId,
          call.batchIndex,
          call.attempt,
          call.textCount,
          call.tokenCount,
          call.durationMs,
          call.errorCode,
          call.errorMessage,
          call.documentId,
          call.relPath,
          call.documentName,
        );
      const statement = this.#db.prepare(
        `INSERT INTO embedding_call_items (
            call_id, text_index, chunk_id, ordinal, content_hash, content_preview,
            token_count, section_path, line_start, line_end
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items) {
        statement.run(
          item.callId,
          item.textIndex,
          item.chunkId,
          item.ordinal,
          item.contentHash,
          item.contentPreview,
          item.tokenCount,
          item.sectionPath,
          item.lineStart,
          item.lineEnd,
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  listEmbeddingCalls(options: { status?: string; limit?: number; offset?: number } = {}): {
    items: EmbeddingCall[];
    total: number;
  } {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (options.status !== undefined) {
      clauses.push('status = ?');
      parameters.push(options.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM embedding_calls ${where}`)
      .get(...parameters) as { total: number | bigint };
    const rows = this.#db
      .prepare(
        `SELECT * FROM embedding_calls ${where} ORDER BY triggered_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset) as unknown as EmbeddingCallRow[];
    return { items: rows.map(embeddingCallFromRow), total: Number(totalRow.total) };
  }

  getEmbeddingCall(
    callId: string,
  ): { call: EmbeddingCall; items: EmbeddingCallItem[] } | undefined {
    const row = this.#db.prepare('SELECT * FROM embedding_calls WHERE id = ?').get(callId) as
      EmbeddingCallRow | undefined;
    if (row === undefined) return undefined;
    const items = this.#db
      .prepare('SELECT * FROM embedding_call_items WHERE call_id = ? ORDER BY text_index')
      .all(callId) as unknown as EmbeddingCallItemRow[];
    return {
      call: embeddingCallFromRow(row),
      items: items.map(embeddingCallItemFromRow),
    };
  }

  countEmbeddingCalls(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM embedding_calls').get() as {
      total: number | bigint;
    };
    return Number(row.total);
  }

  /** 删除截止时间之前的记录（先明细后主表；无外键，与现有表约定一致）。返回删除的主表行数。 */
  deleteEmbeddingCallsBefore(cutoffIso: string): number {
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare(
          'DELETE FROM embedding_call_items WHERE call_id IN (SELECT id FROM embedding_calls WHERE triggered_at < ?)',
        )
        .run(cutoffIso);
      const result = this.#db
        .prepare('DELETE FROM embedding_calls WHERE triggered_at < ?')
        .run(cutoffIso);
      this.#db.exec('COMMIT');
      return Number(result.changes);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  clearEmbeddingCalls(): void {
    this.#db.exec('BEGIN');
    try {
      this.#db.exec('DELETE FROM embedding_call_items');
      this.#db.exec('DELETE FROM embedding_calls');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): LibraryStats {
    const row = this.#db
      .prepare(
        `SELECT
            (SELECT COUNT(*) FROM sources) AS sources,
            (SELECT COUNT(*) FROM documents) AS documents,
            (SELECT COUNT(*) FROM documents WHERE status = 'indexed') AS indexed_documents,
            (SELECT COUNT(*) FROM documents WHERE status = 'error') AS failed_documents`,
      )
      .get() as {
      sources: number;
      documents: number;
      indexed_documents: number;
      failed_documents: number;
    };
    return {
      sources: Number(row.sources),
      documents: Number(row.documents),
      indexedDocuments: Number(row.indexed_documents),
      failedDocuments: Number(row.failed_documents),
    };
  }

  /** 按来源聚合文档状态计数；LEFT JOIN 保证零文档来源也有一行，UI 按 sourceId 直接取用。 */
  sourceDocumentStats(): SourceDocumentStats[] {
    const rows = this.#db
      .prepare(
        `SELECT s.id AS source_id,
                COUNT(d.id) AS documents,
                COALESCE(SUM(CASE WHEN d.status = 'indexed' THEN 1 ELSE 0 END), 0) AS indexed_documents,
                COALESCE(SUM(CASE WHEN d.status = 'error' THEN 1 ELSE 0 END), 0) AS failed_documents,
                COALESCE(SUM(CASE WHEN d.status = 'manual_required' THEN 1 ELSE 0 END), 0) AS manual_required
         FROM sources s
         LEFT JOIN documents d ON d.source_id = s.id
         GROUP BY s.id`,
      )
      .all() as Array<{
      source_id: string;
      documents: number;
      indexed_documents: number;
      failed_documents: number;
      manual_required: number;
    }>;
    return rows.map((row) => ({
      sourceId: String(row.source_id),
      documents: Number(row.documents),
      indexedDocuments: Number(row.indexed_documents),
      failedDocuments: Number(row.failed_documents),
      manualRequiredDocuments: Number(row.manual_required),
    }));
  }
}

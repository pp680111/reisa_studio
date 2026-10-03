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
    UNIQUE(source_id, rel_path)
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
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
}

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
            chunk_count, size, mtime_ns, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            content_hash = excluded.content_hash,
            status = excluded.status,
            error = excluded.error,
            chunk_count = excluded.chunk_count,
            size = excluded.size,
            mtime_ns = excluded.mtime_ns,
            indexed_at = excluded.indexed_at`,
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

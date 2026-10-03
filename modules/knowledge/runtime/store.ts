import * as lancedb from '@lancedb/lancedb';
import {
  Field,
  FixedSizeList,
  Float32,
  Int32,
  Schema,
  TimestampMicrosecond,
  Utf8,
} from 'apache-arrow';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LanceDB 分块存储（迁移自 skb store.py）。
 * 得分列防御链：_relevance_score → _score → 1-_distance → 1.0
 * （JS SDK 实测：FTS 返回 _score，hybrid 两者都有——见迁移设计文档 §10.1）。
 */

export interface ChunkRecord {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly ordinal: number;
  readonly content: string;
  readonly contentHash: string;
  readonly tokenCount: number;
  readonly documentName: string;
  readonly sectionPath: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly mimeType: string;
  readonly modifiedAt: Date;
  readonly vector: readonly number[];
}

export interface SearchHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly content: string;
  readonly documentName: string;
  readonly sectionPath: string | null;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly score: number;
}

export type SearchMode = 'hybrid' | 'vector' | 'full_text';

/** 串行化写入（skb 的 RLock 语义）；同一文档先删后加必须是原子序列。 */
class AsyncMutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

interface IndexConfigLike {
  readonly name?: string;
  readonly columns?: readonly string[];
}

interface QueryRow {
  readonly chunk_id: string;
  readonly document_id: string;
  readonly source_id: string;
  readonly content: string;
  readonly document_name: string;
  readonly section_path?: string | null;
  readonly line_start?: number | null;
  readonly line_end?: number | null;
  readonly _relevance_score?: number;
  readonly _score?: number;
  readonly _distance?: number;
}

export class ChunkStore {
  static readonly TABLE_NAME = 'chunks';

  readonly #dimensions: number;
  readonly #mutex = new AsyncMutex();
  readonly #db: lancedb.Connection;
  #table: lancedb.Table | undefined;

  private constructor(dimensions: number, db: lancedb.Connection) {
    this.#dimensions = dimensions;
    this.#db = db;
  }

  static async open(path: string, dimensions: number): Promise<ChunkStore> {
    mkdirSync(path, { recursive: true });
    const db = await lancedb.connect(path);
    const store = new ChunkStore(dimensions, db);
    const tables = await db.tableNames();
    if (tables.includes(ChunkStore.TABLE_NAME)) {
      const table = await db.openTable(ChunkStore.TABLE_NAME);
      await store.#validateSchema(table);
      store.#table = table;
    } else {
      store.#table = await db.createTable(ChunkStore.TABLE_NAME, [], { schema: store.#schema() });
    }
    return store;
  }

  async #validateSchema(table: lancedb.Table): Promise<void> {
    const schema = await table.schema();
    const field = schema.fields.find((entry) => entry.name === 'vector');
    const expected = new FixedSizeList(this.#dimensions, new Field('item', new Float32(), true));
    // arrow v18 的 DataType 没有 equals，用字符串比较（spike 实测可行）
    if (field?.type.toString() !== expected.toString()) {
      throw new Error(
        'Existing index was built with a different embedding dimension; remove the data directory to rebuild.',
      );
    }
  }

  #schema(): Schema {
    return new Schema([
      new Field('chunk_id', new Utf8(), false),
      new Field('document_id', new Utf8(), false),
      new Field('source_id', new Utf8(), false),
      new Field('ordinal', new Int32(), false),
      new Field('content', new Utf8(), false),
      new Field('content_hash', new Utf8(), false),
      new Field('token_count', new Int32(), false),
      new Field('document_name', new Utf8(), false),
      new Field('section_path', new Utf8(), true),
      new Field('line_start', new Int32(), true),
      new Field('line_end', new Int32(), true),
      new Field('mime_type', new Utf8(), false),
      new Field('modified_at', new TimestampMicrosecond('UTC'), false),
      new Field(
        'vector',
        new FixedSizeList(this.#dimensions, new Field('item', new Float32(), true)),
        false,
      ),
    ]);
  }

  get #chunkTable(): lancedb.Table {
    if (this.#table === undefined) throw new Error('ChunkStore 未打开');
    return this.#table;
  }

  /** 原子替换单个文档的全部分块：先删旧行，再写新行。 */
  async replaceDocument(records: readonly ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    const documentId = records[0]?.documentId ?? '';
    const rows = records.map((record) => this.#recordToRow(record));
    await this.#mutex.run(async () => {
      const table = this.#chunkTable;
      await table.delete(`document_id = '${escapeLiteral(documentId)}'`);
      await table.add(rows);
    });
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.#mutex.run(() =>
      this.#chunkTable.delete(`document_id = '${escapeLiteral(documentId)}'`),
    );
  }

  async deleteSource(sourceId: string): Promise<void> {
    await this.#mutex.run(() =>
      this.#chunkTable.delete(`source_id = '${escapeLiteral(sourceId)}'`),
    );
  }

  async search(options: {
    queryText: string;
    queryVector: readonly number[] | null;
    mode: SearchMode;
    limit: number;
  }): Promise<SearchHit[]> {
    await this.ensureIndexes();
    const { queryText, mode, limit } = options;
    if (mode === 'full_text') {
      const rows = (await this.#chunkTable
        .search(queryText, 'fts')
        .limit(limit)
        .toArray()) as QueryRow[];
      return rows.map(toHit);
    }
    const queryVector = options.queryVector;
    if (queryVector === null) {
      throw new Error('A query vector is required for vector and hybrid search');
    }
    if (queryVector.length !== this.#dimensions) {
      throw new Error(
        `Query vector has dimension ${queryVector.length}, expected ${this.#dimensions}`,
      );
    }
    if (mode === 'vector') {
      const query = this.#chunkTable.search([...queryVector], 'vector') as lancedb.VectorQuery;
      const rows = (await query.distanceType('cosine').limit(limit).toArray()) as QueryRow[];
      return rows.map(toHit);
    }
    const reranker = await lancedb.rerankers.RRFReranker.create(60);
    const hybridQuery = this.#chunkTable.search([...queryVector], 'vector') as lancedb.VectorQuery;
    const rows = (await hybridQuery
      .distanceType('cosine')
      .fullTextSearch(queryText)
      .rerank(reranker)
      .limit(limit)
      .toArray()) as QueryRow[];
    return rows.map(toHit);
  }

  /** 同步建好 FTS 与 ANN 索引：个人规模数据量小，文档索引成功即可检索（skb 语义）。 */
  async ensureIndexes(): Promise<void> {
    await this.#mutex.run(async () => {
      const table = this.#chunkTable;
      const indices = (await table.listIndices()) as IndexConfigLike[];
      const hasIndexOn = (column: string): boolean =>
        indices.some((index) => (index.columns ?? []).includes(column));
      if (!hasIndexOn('content')) {
        await table.createIndex('content', {
          config: lancedb.Index.fts({
            withPosition: true,
            baseTokenizer: 'icu',
            stem: false,
            removeStopWords: false,
            asciiFolding: false,
          }),
          replace: false,
        });
      }
      if (!hasIndexOn('vector') && (await table.countRows()) > 0) {
        try {
          await table.createIndex('vector', {
            config: lancedb.Index.ivfFlat({ distanceType: 'cosine' }),
            replace: false,
          });
        } catch {
          // skb 同样吞掉 ANN 建索引失败（未索引向量走全量扫描兜底）
        }
      }
    });
  }

  async chunkCount(): Promise<number> {
    return this.#chunkTable.countRows();
  }

  /** 释放 LanceDB 连接持有的底层资源；Windows 下必须先关闭才能安全删除索引目录。 */
  async close(): Promise<void> {
    const table = this.#table;
    this.#table = undefined;
    if (table === undefined) return;
    try {
      this.#db.close();
    } catch {
      // 关闭失败不影响调用方（连接被 GC 时也会自动释放）
    }
  }

  #recordToRow(record: ChunkRecord): Record<string, unknown> {
    if (record.vector.length !== this.#dimensions) {
      throw new Error(
        `Chunk vector has dimension ${record.vector.length}, expected ${this.#dimensions}`,
      );
    }
    return {
      chunk_id: record.chunkId,
      document_id: record.documentId,
      source_id: record.sourceId,
      ordinal: record.ordinal,
      content: record.content,
      content_hash: record.contentHash,
      token_count: record.tokenCount,
      document_name: record.documentName,
      section_path: record.sectionPath,
      line_start: record.lineStart,
      line_end: record.lineEnd,
      mime_type: record.mimeType,
      modified_at: record.modifiedAt,
      vector: [...record.vector],
    };
  }
}

function toHit(row: QueryRow): SearchHit {
  const score =
    row._relevance_score !== undefined
      ? Number(row._relevance_score)
      : row._score !== undefined
        ? Number(row._score)
        : row._distance !== undefined
          ? 1.0 - Number(row._distance)
          : 1.0;
  return {
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    sourceId: String(row.source_id),
    content: String(row.content),
    documentName: String(row.document_name),
    sectionPath: row.section_path ?? null,
    lineStart: Number(row.line_start ?? 0),
    lineEnd: Number(row.line_end ?? 0),
    score,
  };
}

function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export function chunkIndexPath(dataDir: string): string {
  return join(dataDir, 'index');
}

/**
 * 元数据与 LanceDB 存储测试（移植自 skb tests/unit/test_store.py 与 db 相关用例）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MetadataDB, documentIdentity } from '../runtime/db.ts';
import { ChunkStore } from '../runtime/store.ts';
import { fakeVector } from './fake-embedder.mjs';

async function makeTemp() {
  return mkdtemp(join(tmpdir(), 'kb-store-'));
}

test('来源 CRUD 与按路径查找', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  const source = db.createSource({ type: 'local_dir', path: '/docs', name: 'docs' });
  assert.match(source.id, /^[0-9a-f]{32}$/);
  assert.equal(db.listSources().length, 1);
  assert.equal(db.findSourceByPath('/docs')?.id, source.id);
  assert.equal(db.findSourceByPath('/other'), undefined);
  db.updateSourceRules(source.id, '*.draft.md');
  assert.equal(db.getSource(source.id)?.ignoreRules, '*.draft.md');
  db.deleteSource(source.id);
  assert.equal(db.listSources().length, 0);
});

test('老库迁移：sources 缺 ignore_rules 列时自动补列（skb 用例）', async () => {
  const dir = await makeTemp();
  const path = join(dir, 'old.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(
    'CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT NOT NULL, ' +
      'path TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)',
  );
  legacy.prepare("INSERT INTO sources VALUES ('old', 'local_dir', '/docs', 'docs', 'now')").run();
  legacy.close();

  const database = new MetadataDB(path);
  assert.equal(database.getSource('old')?.ignoreRules, '');
  database.updateSourceRules('old', '# comment\n*.draft.md');
  database.close();

  const reopened = new MetadataDB(path);
  assert.equal(reopened.getSource('old')?.ignoreRules, '# comment\n*.draft.md');
  reopened.close();
});

test('外来旧表（93577ee 原型的 documents）改名保留并重建（回归：no such column: rel_path）', async () => {
  const dir = await makeTemp();
  const path = join(dir, 'kb.db');
  const legacy = new DatabaseSync(path);
  // 旧原型 knowledge 模块的 documents 表形状（无 source_id / rel_path / status）
  legacy.exec(
    'CREATE TABLE documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, ' +
      'content TEXT NOT NULL, created_at INTEGER NOT NULL)',
  );
  legacy.prepare("INSERT INTO documents VALUES ('d1', '旧文档', '旧内容', 123)").run();
  legacy.close();

  const database = new MetadataDB(path);
  // 新表形状可用，listDocuments 不再报 no such column
  assert.equal(database.listDocuments().total, 0);
  assert.ok(
    database.listLegacyTables().some((name) => name.startsWith('documents_legacy')),
    '旧表应改名保留',
  );
  const archive = new DatabaseSync(path);
  const old = archive
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'documents_legacy%'",
    )
    .all();
  assert.equal(old.length, 1, '归档表存在');
  const rows = archive
    .prepare(`SELECT id, name, content FROM ${old[0].name} WHERE id = 'd1'`)
    .all();
  assert.equal(rows.length, 1, '旧数据仍在归档表中');
  archive.close();
  database.close();
});

test('documentIdentity：确定性、区分输入、v5 格式', () => {
  const first = documentIdentity('src-1', 'docs/a.md');
  assert.equal(first, documentIdentity('src-1', 'docs/a.md'));
  assert.notEqual(first, documentIdentity('src-1', 'docs/b.md'));
  assert.notEqual(first, documentIdentity('src-2', 'docs/a.md'));
  assert.match(first, /^[0-9a-f]{32}$/);
  // version 5 与 10xx variant 位
  assert.equal(parseInt(first.slice(12, 13), 16), 5);
  assert.ok([8, 9, 10, 11].includes(parseInt(first.slice(16, 17), 16)));
});

test('文档 upsert 与列表过滤', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  const source = db.createSource({ type: 'local_dir', path: '/docs', name: 'docs' });
  const base = {
    sourceId: source.id,
    contentHash: null,
    error: null,
    chunkCount: 0,
    size: 1,
    mtimeNs: 1n,
    indexedAt: null,
    retryCount: 0,
  };
  db.upsertDocument({ ...base, id: 'd1', relPath: 'a.md', name: 'a.md', status: 'indexed' });
  db.upsertDocument({ ...base, id: 'd2', relPath: 'b.md', name: 'b.md', status: 'error' });
  const all = db.listDocuments();
  assert.equal(all.total, 2);
  assert.equal(db.listDocuments({ status: 'error' }).items[0]?.id, 'd2');
  assert.equal(db.listDocuments({ sourceId: source.id }).total, 2);
  db.upsertDocument({ ...base, id: 'd1', relPath: 'a.md', name: 'a.md', status: 'error' });
  assert.equal(db.getDocument('d1')?.status, 'error', 'upsert 按 id 覆盖');
  db.upsertDocument({
    ...base,
    id: 'd2',
    relPath: 'b.md',
    name: 'b.md',
    status: 'error',
    retryCount: 3,
  });
  assert.equal(db.getDocument('d2')?.retryCount, 3, 'retry_count 随 upsert 写入并回读');
});

test('stats 汇总', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  db.setSetting('embedding_identity', 'abc');
  assert.equal(db.getSetting('embedding_identity'), 'abc');
  const stats = db.stats();
  assert.deepEqual(stats, {
    sources: 0,
    documents: 0,
    indexedDocuments: 0,
    failedDocuments: 0,
  });
});

test('sourceDocumentStats 按来源聚合各状态文档数（含零文档来源）', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  const dir = db.createSource({ type: 'local_dir', path: '/docs', name: 'docs' });
  const uploads = db.createSource({ type: 'upload', path: '/uploads', name: 'uploads' });
  const base = {
    contentHash: null,
    error: null,
    chunkCount: 0,
    size: 1,
    mtimeNs: 1n,
    indexedAt: null,
    retryCount: 0,
  };
  const doc = (id, sourceId, status) =>
    db.upsertDocument({ ...base, id, sourceId, relPath: `${id}.md`, name: `${id}.md`, status });
  doc('a1', dir.id, 'indexed');
  doc('a2', dir.id, 'indexed');
  doc('a3', dir.id, 'error');
  doc('a4', dir.id, 'manual_required');
  doc('a5', dir.id, 'queued');

  const rows = new Map(db.sourceDocumentStats().map((row) => [row.sourceId, row]));
  assert.equal(rows.size, 2);
  const dirStats = rows.get(dir.id);
  assert.equal(dirStats.documents, 5);
  assert.equal(dirStats.indexedDocuments, 2);
  assert.equal(dirStats.failedDocuments, 1);
  assert.equal(dirStats.manualRequiredDocuments, 1);
  const uploadsStats = rows.get(uploads.id);
  assert.equal(uploadsStats.documents, 0);
  assert.equal(uploadsStats.indexedDocuments, 0);

  db.deleteSource(dir.id);
  const after = db.sourceDocumentStats();
  assert.equal(after.length, 1);
  assert.equal(after[0].sourceId, uploads.id);
});

function makeRecord(documentId, ordinal, content, seed = 1) {
  return {
    chunkId: `${documentId}-${ordinal}`,
    documentId,
    sourceId: 'src-1',
    ordinal,
    content,
    contentHash: String(ordinal),
    tokenCount: content.length,
    documentName: 'doc.md',
    sectionPath: '标题',
    lineStart: ordinal + 1,
    lineEnd: ordinal + 2,
    mimeType: 'text/plain',
    modifiedAt: new Date(),
    vector: fakeVector(content, 16),
  };
}

test('三种检索模式 roundtrip（skb test_store 用例）', async () => {
  const dir = await makeTemp();
  const store = await ChunkStore.open(join(dir, 'index'), 16);
  await store.replaceDocument([
    makeRecord('doc-a', 0, '数据库连接配置在配置文件中'),
    makeRecord('doc-a', 1, 'watchdog 负责文件监听'),
  ]);
  assert.equal(await store.chunkCount(), 2);

  const fts = await store.search({
    queryText: '数据库连接',
    queryVector: null,
    mode: 'full_text',
    limit: 5,
  });
  assert.ok(fts.length >= 1);
  assert.equal(fts[0]?.documentId, 'doc-a');
  assert.equal(fts[0]?.score > 0, true);

  const vector = await store.search({
    queryText: '数据库',
    queryVector: fakeVector('数据库连接配置在配置文件中', 16),
    mode: 'vector',
    limit: 5,
  });
  assert.equal(vector[0]?.content, '数据库连接配置在配置文件中');
  assert.ok(vector[0]?.score > 0.5);

  const hybrid = await store.search({
    queryText: '数据库连接',
    queryVector: fakeVector('数据库连接配置在配置文件中', 16),
    mode: 'hybrid',
    limit: 5,
  });
  assert.ok(hybrid.length >= 1);
  assert.equal(hybrid[0]?.documentId, 'doc-a');
});

test('同文档替换是原子序列', async () => {
  const dir = await makeTemp();
  const store = await ChunkStore.open(join(dir, 'index'), 16);
  await store.replaceDocument([makeRecord('doc-a', 0, 'first'), makeRecord('doc-a', 1, 'second')]);
  await store.replaceDocument([makeRecord('doc-a', 0, 'replaced')]);
  assert.equal(await store.chunkCount(), 1);
  const hits = await store.search({
    queryText: 'replaced',
    queryVector: null,
    mode: 'full_text',
    limit: 5,
  });
  assert.equal(hits.length, 1);
});

test('删来源级联清理向量', async () => {
  const dir = await makeTemp();
  const store = await ChunkStore.open(join(dir, 'index'), 16);
  await store.replaceDocument([makeRecord('doc-a', 0, 'alpha beta')]);
  await store.deleteSource('src-1');
  assert.equal(await store.chunkCount(), 0);
});

test('维度不匹配的查询向量被拒绝', async () => {
  const dir = await makeTemp();
  const store = await ChunkStore.open(join(dir, 'index'), 16);
  await assert.rejects(() =>
    store.search({
      queryText: 'x',
      queryVector: fakeVector('x', 8),
      mode: 'vector',
      limit: 3,
    }),
  );
});

test('打开不同维度的已有索引被拒绝（skb schema 校验用例）', async () => {
  const dir = await makeTemp();
  const store = await ChunkStore.open(join(dir, 'index'), 16);
  await store.replaceDocument([makeRecord('doc-a', 0, 'hello')]);
  await assert.rejects(() => ChunkStore.open(join(dir, 'index'), 8), /dimension/);
});

test('close() 释放连接后索引目录可被删除（重配置重建路径）', async () => {
  const dir = await makeTemp();
  const indexDir = join(dir, 'index');
  const store = await ChunkStore.open(indexDir, 16);
  await store.replaceDocument([makeRecord('doc-a', 0, 'hello world')]);
  assert.ok((await store.chunkCount()) === 1);
  await store.close();
  // 指纹变更时 #buildServices 需要 rm 整个索引目录：连接未释放时 Windows 下会 EBUSY
  await rm(indexDir, { recursive: true, force: true });
  const reopened = await ChunkStore.open(indexDir, 16);
  assert.equal(await reopened.chunkCount(), 0, '删除后为全新空索引');
  await reopened.close();
});

// ---- embedding 调用记录（knowledge-embedding-call-log 设计）----

function makeCall(id, triggeredAt, overrides = {}) {
  return {
    id,
    triggeredAt,
    status: 'success',
    model: 'fake-model',
    roundId: 'round-1',
    batchIndex: 0,
    attempt: 0,
    textCount: 2,
    tokenCount: 9,
    durationMs: 120,
    errorCode: null,
    errorMessage: null,
    documentId: 'doc-1',
    relPath: 'a.md',
    documentName: 'a.md',
    ...overrides,
  };
}

function makeCallItem(callId, textIndex, overrides = {}) {
  return {
    callId,
    textIndex,
    chunkId: `chunk-${textIndex}`,
    ordinal: textIndex,
    contentHash: `hash-${textIndex}`,
    contentPreview: `预览${textIndex}`,
    tokenCount: 4,
    sectionPath: '标题',
    lineStart: textIndex + 1,
    lineEnd: textIndex + 2,
    ...overrides,
  };
}

test('embedding 调用记录：insert/list 按时间倒序、状态筛选与分页', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  db.insertEmbeddingCall(makeCall('c1', '2026-11-01T00:00:00Z'), [
    makeCallItem('c1', 0),
    makeCallItem('c1', 1),
  ]);
  db.insertEmbeddingCall(
    makeCall('c2', '2026-11-02T00:00:00Z', {
      status: 'failed',
      tokenCount: null,
      errorCode: 'rate_limited',
      errorMessage: '429',
    }),
    [],
  );
  db.insertEmbeddingCall(makeCall('c0', '2020-01-01T00:00:00Z'), []);

  const all = db.listEmbeddingCalls();
  assert.equal(all.total, 3);
  assert.deepEqual(
    all.items.map((call) => call.id),
    ['c2', 'c1', 'c0'],
    '按时间倒序',
  );

  const failed = db.listEmbeddingCalls({ status: 'failed' });
  assert.equal(failed.total, 1);
  assert.equal(failed.items[0]?.errorCode, 'rate_limited');
  assert.equal(failed.items[0]?.tokenCount, null);

  const paged = db.listEmbeddingCalls({ limit: 1, offset: 1 });
  assert.equal(paged.items[0]?.id, 'c1');
});

test('embedding 调用记录：get 含明细（按 text_index 排序），不存在返回 undefined', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  db.insertEmbeddingCall(makeCall('c1', '2026-11-01T00:00:00Z'), [
    makeCallItem('c1', 1),
    makeCallItem('c1', 0),
  ]);
  const detail = db.getEmbeddingCall('c1');
  assert.equal(detail?.call.documentName, 'a.md');
  assert.deepEqual(
    detail?.items.map((item) => item.textIndex),
    [0, 1],
    '明细按 text_index 排序',
  );
  assert.equal(db.getEmbeddingCall('missing'), undefined);
});

test('embedding 调用记录：保留期清理只删过期（含明细），clear 全清', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  db.insertEmbeddingCall(makeCall('old', '2020-01-01T00:00:00Z'), [makeCallItem('old', 0)]);
  db.insertEmbeddingCall(makeCall('keep', '2026-11-01T00:00:00Z'), [makeCallItem('keep', 0)]);

  const removed = db.deleteEmbeddingCallsBefore('2021-01-01T00:00:00Z');
  assert.equal(removed, 1, '只删除截止时间前的主表行');
  assert.equal(db.listEmbeddingCalls().total, 1);
  assert.equal(db.getEmbeddingCall('keep')?.items.length, 1, '未过期记录明细保留');

  db.clearEmbeddingCalls();
  assert.equal(db.listEmbeddingCalls().total, 0);
  assert.equal(db.getEmbeddingCall('keep'), undefined);
  assert.equal(db.countEmbeddingCalls(), 0);
});

test('老库迁移：embedding_calls 缺轮次/批次/尝试列时自动补列（回归：no such column named round_id）', async () => {
  const dir = await makeTemp();
  const path = join(dir, 'kb.db');
  const legacy = new DatabaseSync(path);
  // 记录粒度重构前的表形状（无 round_id / batch_index / attempt）
  legacy.exec(
    'CREATE TABLE embedding_calls (' +
      'id TEXT PRIMARY KEY, triggered_at TEXT NOT NULL, status TEXT NOT NULL, ' +
      "model TEXT NOT NULL DEFAULT '', text_count INTEGER NOT NULL DEFAULT 0, " +
      'token_count INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0, ' +
      'error_code TEXT, error_message TEXT, document_id TEXT NOT NULL, ' +
      'rel_path TEXT NOT NULL, document_name TEXT NOT NULL)',
  );
  legacy
    .prepare(
      'INSERT INTO embedding_calls (id, triggered_at, status, document_id, rel_path, document_name) ' +
        "VALUES ('old', '2026-11-08T00:00:00Z', 'success', 'doc-1', 'a.md', 'a.md')",
    )
    .run();
  legacy.close();

  const database = new MetadataDB(path);
  try {
    // 老行可读，新列带默认值
    const old = database.listEmbeddingCalls().items.find((call) => call.id === 'old');
    assert.equal(old?.status, 'success');
    assert.equal(old?.roundId, '');
    assert.equal(old?.batchIndex, 0);
    assert.equal(old?.attempt, 0);
    // 新行可插入（回归用户报告的 embedding_call_log_failed: no column named round_id）
    database.insertEmbeddingCall(makeCall('new', '2026-11-09T00:00:00Z'), [makeCallItem('new', 0)]);
    assert.equal(database.listEmbeddingCalls().total, 2);
    const detail = database.getEmbeddingCall('new');
    assert.equal(detail?.call.roundId, 'round-1');
    assert.equal(detail?.items.length, 1);
  } finally {
    database.close();
  }
});

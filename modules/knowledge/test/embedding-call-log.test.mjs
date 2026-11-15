/**
 * 索引类 embedding 接口调用记录器测试（设计文档 docs/knowledge-embedding-call-log.md）。
 * 记录粒度 = 每一次真实接口请求：覆盖落库、无上下文跳过、旁路吞错、保留期清理、码点截断。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataDB } from '../runtime/db.ts';
import {
  EmbeddingCallRecorder,
  contentPreview,
  embeddingCallCutoffIso,
} from '../runtime/embedding-call-log.ts';

async function makeTemp() {
  return mkdtemp(join(tmpdir(), 'kb-call-log-'));
}

function makeChunk(ordinal) {
  return {
    chunkId: `chunk-${ordinal}`,
    ordinal,
    content: `第 ${ordinal} 段内容`,
    contentHash: `hash-${ordinal}`,
    tokenCount: 5,
    sectionPath: ordinal === 0 ? '标题A' : null,
    lineStart: ordinal + 1,
    lineEnd: ordinal + 2,
  };
}

/** 构造一条接口请求遥测事件（与 embedding.ts onRequest 发出的形状一致）。 */
function makeEvent(overrides = {}) {
  const items = overrides.items ?? [makeChunk(0), makeChunk(1)];
  const texts = overrides.texts ?? items.map((chunk) => `${chunk.content}，正文。`);
  return {
    roundId: 'round-1',
    batchIndex: 0,
    attempt: 0,
    status: 'success',
    latencyMs: 42,
    tokenCount: 6,
    errorCode: null,
    errorMessage: null,
    model: 'fake-model',
    texts,
    items,
    context: { documentId: 'doc-1', relPath: 'a.md', documentName: 'a.md' },
    ...overrides,
  };
}

test('索引请求落库：轮次/批次/尝试与 chunk 明细对齐', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  try {
    const recorder = new EmbeddingCallRecorder({ database: db, retentionDays: 30 });
    recorder.recordRequest(makeEvent());
    const { items, total } = db.listEmbeddingCalls();
    assert.equal(total, 1);
    const call = items[0];
    assert.equal(call.status, 'success');
    assert.equal(call.model, 'fake-model');
    assert.equal(call.roundId, 'round-1');
    assert.equal(call.batchIndex, 0);
    assert.equal(call.attempt, 0);
    assert.equal(call.textCount, 2);
    assert.equal(call.tokenCount, 6);
    assert.equal(call.durationMs, 42);
    assert.equal(call.documentName, 'a.md');
    assert.match(call.triggeredAt, /^\d{4}-\d{2}-\d{2}T/);

    const detail = db.getEmbeddingCall(call.id);
    assert.deepEqual(
      detail?.items.map((item) => [item.textIndex, item.chunkId, item.ordinal]),
      [
        [0, 'chunk-0', 0],
        [1, 'chunk-1', 1],
      ],
    );
    // 预览取自实际发送的文本，按码点截取
    assert.match(detail?.items[0]?.contentPreview ?? '', /第 0 段内容/);
    assert.equal(detail?.items[0]?.sectionPath, '标题A');
  } finally {
    db.close();
  }
});

test('失败请求照常落库（errorCode/errorMessage 来自分类后的错误）', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  try {
    const recorder = new EmbeddingCallRecorder({ database: db, retentionDays: 30 });
    recorder.recordRequest(
      makeEvent({
        status: 'failed',
        tokenCount: null,
        errorCode: 'rate_limited',
        errorMessage: 'Embedding request failed (status=429, code=rate_limited)',
      }),
    );
    const failed = db.listEmbeddingCalls({ status: 'failed' });
    assert.equal(failed.total, 1);
    assert.equal(failed.items[0]?.errorCode, 'rate_limited');
    assert.match(failed.items[0]?.errorMessage ?? '', /429/);
    assert.equal(failed.items[0]?.tokenCount, null);
  } finally {
    db.close();
  }
});

test('无文档上下文（检索/连接测试）与空明细的请求不落库', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  try {
    const recorder = new EmbeddingCallRecorder({ database: db, retentionDays: 30 });
    recorder.recordRequest(makeEvent({ context: undefined, items: undefined }));
    recorder.recordRequest(makeEvent({ context: {} }));
    recorder.recordRequest(makeEvent({ items: [], texts: [] }));
    assert.equal(db.countEmbeddingCalls(), 0, '仅索引调用产生记录');
  } finally {
    db.close();
  }
});

test('旁路语义：库已关闭后 recordRequest 不抛出', async () => {
  const dir = await makeTemp();
  const db = new MetadataDB(join(dir, 'kb.db'));
  const recorder = new EmbeddingCallRecorder({ database: db, retentionDays: 30 });
  recorder.recordRequest(makeEvent());
  assert.equal(db.countEmbeddingCalls(), 1);

  db.close();
  assert.doesNotThrow(() => recorder.recordRequest(makeEvent({ roundId: 'round-2' })));
  await rm(dir, { recursive: true, force: true });
});

function makeExpiredCall(id) {
  return {
    id,
    triggeredAt: '2020-01-01T00:00:00Z',
    status: 'success',
    model: 'm',
    roundId: 'round-old',
    batchIndex: 0,
    attempt: 0,
    textCount: 0,
    tokenCount: null,
    durationMs: 0,
    errorCode: null,
    errorMessage: null,
    documentId: 'd',
    relPath: 'a.md',
    documentName: 'a.md',
  };
}

test('每 100 条触发保留期清理：过期记录删除，未过期保留', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  try {
    const recorder = new EmbeddingCallRecorder({ database: db, retentionDays: 30 });
    db.insertEmbeddingCall(makeExpiredCall('expired'), []);
    for (let i = 0; i < 100; i += 1) {
      recorder.recordRequest(
        makeEvent({
          roundId: `round-${i}`,
          context: { documentId: `d${i}`, relPath: 'a.md', documentName: 'a.md' },
          items: [makeChunk(0)],
          texts: ['文本'],
        }),
      );
    }
    const ids = db.listEmbeddingCalls({ limit: 1000 }).items.map((call) => call.id);
    assert.ok(!ids.includes('expired'), '第 100 条写入后应顺带清理过期记录');
    assert.equal(ids.length, 100);
  } finally {
    db.close();
  }
});

test('retentionDays=0：永久保留，周期清理不生效', async () => {
  const db = new MetadataDB(join(await makeTemp(), 'kb.db'));
  try {
    const recorder = new EmbeddingCallRecorder({ database: db, retentionDays: 0 });
    db.insertEmbeddingCall(makeExpiredCall('expired'), []);
    for (let i = 0; i < 100; i += 1) {
      recorder.recordRequest(
        makeEvent({
          roundId: `round-${i}`,
          context: { documentId: `d${i}`, relPath: 'a.md', documentName: 'a.md' },
          items: [makeChunk(0)],
          texts: ['文本'],
        }),
      );
    }
    assert.equal(db.countEmbeddingCalls(), 101, '0 表示永久保留，过期记录不被清理');
  } finally {
    db.close();
  }
});

test('contentPreview 按码点截断，不切断代理对', () => {
  const emoji = '😀'.repeat(130);
  const preview = contentPreview(emoji);
  assert.equal(Array.from(preview).length, 120);
  assert.ok(!preview.includes('\uFFFD'), '不产生无效 UTF-16');
  assert.equal(contentPreview('短文本'), '短文本', '未超长原样返回');
});

test('embeddingCallCutoffIso：0/负值不清理，正值约为 N 天前', () => {
  assert.equal(embeddingCallCutoffIso(0), null);
  assert.equal(embeddingCallCutoffIso(-5), null);
  const cutoff = embeddingCallCutoffIso(30);
  assert.match(cutoff ?? '', /^\d{4}-\d{2}-\d{2}T/);
  const expected = Date.now() - 30 * 86_400_000;
  assert.ok(Math.abs(new Date(cutoff ?? '').getTime() - expected) < 5000);
});

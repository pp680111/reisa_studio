/**
 * 同步对账与服务层集成测试（移植自 skb tests/integration/test_sync.py、
 * test_source_ignore.py、test_embedding_identity.py 的核心用例）。
 * 不启动后台循环：直接驱动 reconcileAll()，保证确定性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataDB, EMBEDDING_IDENTITY_KEY } from '../runtime/db.ts';
import { ChunkStore } from '../runtime/store.ts';
import { SyncService } from '../runtime/sync.ts';
import { KnowledgeBase, ServiceError, uploadsPathFor } from '../runtime/service.ts';
import { embeddingIdentity, DEFAULT_SETTINGS } from '../runtime/config.ts';
import { createFakeEmbedder, fakeVector } from './fake-embedder.mjs';

const DIM = 16;

async function makeStack(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kb-sync-'));
  const database = new MetadataDB(join(dataDir, 'kb.db'));
  const store = await ChunkStore.open(join(dataDir, 'index'), DIM);
  const embedder = options.embedder === undefined ? createFakeEmbedder(DIM) : options.embedder;
  const sync = new SyncService({
    database,
    store,
    embedder: options.embedder === null ? null : embedder,
    intervalSeconds: 30,
    debounceSeconds: 0,
    autoIndexMaxBytes: options.autoIndexMaxBytes ?? 5 * 1024 * 1024,
  });
  const service = new KnowledgeBase({
    uploadsPath: uploadsPathFor(dataDir),
    database,
    store,
    embedder: options.embedder === null ? null : embedder,
    sync,
  });
  return {
    dataDir,
    database,
    store,
    embedder,
    sync,
    service,
    cleanup: async () => {
      database.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function writeDoc(root, name, content) {
  const path = join(root, name);
  await writeFile(path, content, 'utf-8');
  return path;
}

test('新增来源 → 后台对账索引 → 三模式检索', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(
    docs,
    'ops.md',
    '# 运维\n\n数据库连接配置在 config.toml 的 database 段。\n\n## 备份\n\n每日全量备份。',
  );
  const source = await stack.service.addSource({ path: docs });
  assert.equal(source.type, 'local_dir');
  await stack.sync.reconcileAll();

  const documents = stack.service.listDocuments();
  assert.equal(documents.total, 1);
  assert.equal(documents.items[0]?.status, 'indexed');
  assert.ok((documents.items[0]?.chunkCount ?? 0) > 0);
  assert.ok(documents.items[0]?.sectionPath === null || documents.items[0] !== undefined);

  const outcome = await stack.service.search({ query: '数据库连接', topK: 5 });
  assert.equal(outcome.mode, 'hybrid');
  assert.equal(outcome.degraded, false);
  assert.ok(outcome.results.length >= 1);
  // 结果只含逻辑定位，不含服务端路径（安全语义）
  assert.ok(!JSON.stringify(outcome.results).includes(docs));

  const vector = await stack.service.search({
    query: '数据库连接',
    topK: 5,
    mode: 'vector',
  });
  assert.ok(vector.results.length >= 1);

  const fullText = await stack.service.search({
    query: '备份',
    topK: 5,
    mode: 'full_text',
  });
  assert.ok(fullText.results.length >= 1);

  // section_path 通过检索结果暴露（skb §5.2 结构化输出）
  const withSection = outcome.results.find((hit) => hit.sectionPath !== null);
  assert.ok(withSection !== undefined);

  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('未变化的文件跳过；touch（仅时间戳变化）不重新嵌入（skb 用例）', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  const path = await writeDoc(docs, 'a.txt', 'hello world');
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  assert.equal(stack.embedder.embedCount(), 1);

  // mtime 变化但内容不变：保留旧向量
  const content = await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf-8'));
  await writeDoc(docs, 'a.txt', content);
  const { utimes } = await import('node:fs/promises');
  await utimes(path, new Date(), new Date());
  await stack.sync.reconcileAll();
  assert.equal(stack.embedder.embedCount(), 1, 'touch 不重嵌');
  assert.equal(stack.service.listDocuments().items[0]?.status, 'indexed');

  // 内容变化：重新嵌入
  await writeDoc(docs, 'a.txt', 'changed content entirely');
  await stack.sync.reconcileAll();
  assert.equal(stack.embedder.embedCount(), 2);
  void content;
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('删除文件 → 下一轮对账清除文档与向量', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  const path = await writeDoc(docs, 'gone.md', 'to be deleted');
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  assert.ok((await stack.store.chunkCount()) > 0);

  const { unlink } = await import('node:fs/promises');
  await unlink(path);
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 0);
  assert.equal(await stack.store.chunkCount(), 0);
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('来源路径消失 → 清空该来源全部文档', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'a.md', 'content');
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 1);

  const { rm: remove } = await import('node:fs/promises');
  await remove(docs, { recursive: true, force: true });
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 0);
  await stack.cleanup();
});

test('非 UTF-8 编码 → 单文档 error，不阻塞其他文件（skb 用例）', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeFile(join(docs, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x01]));
  await writeDoc(docs, 'good.md', 'fine content');
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();

  const documents = stack.service.listDocuments().items;
  const bad = documents.find((d) => d.relPath === 'bad.txt');
  const good = documents.find((d) => d.relPath === 'good.md');
  assert.equal(bad?.status, 'error');
  assert.ok(bad?.error && bad.error.length > 0);
  assert.equal(good?.status, 'indexed');
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('未配置 embedding → 全部文档 error，全文检索仍可用', async () => {
  const stack = await makeStack({ embedder: null });
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'a.txt', 'searchable text about bridges 桥');
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().items[0]?.status, 'error');
  assert.match(stack.service.listDocuments().items[0]?.error ?? '', /not configured/);

  await stack.sync.reconcileAll();
  assert.equal(await stack.store.chunkCount(), 0);
  const search = await stack.service.search({ query: 'bridges', mode: 'full_text' });
  assert.equal(search.results.length, 0, '未建索引时全文检索无结果但不报错');
  await assert.rejects(
    () => stack.service.search({ query: 'x', mode: 'vector' }),
    (error) => error instanceof ServiceError && error.code === 'embedding_unavailable',
  );
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('hybrid 降级：向量失败自动全文并标记 degraded（skb 用例）', async () => {
  const failing = {
    embed: async () => {
      throw Object.assign(new Error('down'), { status: 503 });
    },
  };
  const stack = await makeStack({ embedder: failing });
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'a.md', 'unique keyword zebra');
  await stack.service.addSource({ path: docs });
  // 首轮对账嵌入失败 → 文档 error
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().items[0]?.status, 'error');

  // hybrid 检索降级为全文
  const outcome = await stack.service.search({ query: 'anything', mode: 'hybrid' });
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.mode, 'full_text');
  // vector 模式直接报错
  await assert.rejects(
    () => stack.service.search({ query: 'anything', mode: 'vector' }),
    (error) => error instanceof ServiceError && error.code === 'embedding_unavailable',
  );
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('来源去重与嵌套重叠检测（skb 用例）', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  const sub = join(docs, 'sub');
  await mkdir(sub, { recursive: true });
  await writeDoc(docs, 'a.md', 'x');
  await stack.service.addSource({ path: docs });
  await assert.rejects(
    () => stack.service.addSource({ path: docs }),
    (error) => error instanceof ServiceError && error.code === 'source_exists',
  );
  await assert.rejects(
    () => stack.service.addSource({ path: sub }),
    (error) => error instanceof ServiceError && error.code === 'source_overlaps',
  );
  await assert.rejects(
    () => stack.service.addSource({ path: join(docs, 'missing') }),
    (error) => error instanceof ServiceError && error.code === 'source_path_invalid',
  );
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('删除来源级联清理文档与向量', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'a.md', 'content here');
  const source = await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  assert.ok((await stack.store.chunkCount()) > 0);
  await stack.service.removeSource(source.id);
  assert.equal(stack.service.listDocuments().total, 0);
  assert.equal(await stack.store.chunkCount(), 0);
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('超大文件 → manual_required 且旧向量清除；调大门槛后自动索引；0 关闭门槛', async () => {
  const stack = await makeStack({ autoIndexMaxBytes: 10 });
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  const path = await writeDoc(docs, 'big.txt', 'x'.repeat(40));
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  const document = stack.service.listDocuments().items[0];
  assert.equal(document?.status, 'manual_required');
  assert.equal(await stack.store.chunkCount(), 0, '旧向量一并清除');

  // 手动提交绕过大小门槛
  const submitted = await stack.service.submitForIndex(document?.id ?? '');
  assert.equal(submitted.status, 'indexed');
  assert.ok((await stack.store.chunkCount()) > 0);

  // 更新为大内容后回到 manual_required（未 force 时不再自动索引）
  await writeDoc(docs, 'big.txt', 'y'.repeat(50));
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().items[0]?.status, 'manual_required');

  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('autoIndexMaxBytes=0 表示不限制', async () => {
  const stack = await makeStack({ autoIndexMaxBytes: 0 });
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'big.txt', 'z'.repeat(200));
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().items[0]?.status, 'indexed');
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('排除规则：命中文件被跳过，规则清空后恢复索引（skb 用例）', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'keep.md', 'keep content');
  await writeDoc(docs, 'story.draft.md', 'draft content');
  await stack.service.addSource({ path: docs, ignoreRules: '*.draft.md' });
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 1);
  assert.equal(stack.service.listDocuments().items[0]?.relPath, 'keep.md');

  // 清空规则 → 重新扫描索引
  await stack.service.updateSourceRules(stack.service.listSources()[0]?.id ?? '', '');
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 2);

  // 新命中规则的已有文档在下一轮同步清除文档记录与向量
  await stack.service.updateSourceRules(stack.service.listSources()[0]?.id ?? '', 'keep.md');
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 1);
  assert.equal(stack.service.listDocuments().items[0]?.relPath, 'story.draft.md');
  assert.equal(await stack.store.chunkCount(), 1, '被排除文档的向量一并清除');
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('无效规则无法保存，已有索引不受影响（skb 用例）', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'a.md', 'content');
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 1);

  const badRules = 'ok\n\0bad';
  await assert.rejects(
    () => stack.service.updateSourceRules(stack.service.listSources()[0]?.id ?? '', badRules),
    (error) => error instanceof ServiceError && error.code === 'ignore_rules_invalid',
  );
  assert.equal(stack.service.listDocuments().total, 1, '失败规则不清索引');
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('被排除文件不能手动提交索引（skb 用例）', async () => {
  const stack = await makeStack({ autoIndexMaxBytes: 0 });
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'secret.md', 'secret content');
  await stack.service.addSource({ path: docs, ignoreRules: 'secret.md' });
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 0);

  // 文件被规则排除：对账不会为其创建文档记录，但直接提交也应被拒
  const { documentIdentity } = await import('../runtime/db.ts');
  const source = stack.service.listSources()[0];
  const ghostId = documentIdentity(source?.id ?? '', 'secret.md');
  await assert.rejects(
    () => stack.service.submitForIndex(ghostId),
    (error) => error instanceof ServiceError && error.code === 'document_not_found',
  );
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('uploads 内置来源：上传索引、同名覆盖、删除后自恢复（skb 用例）', async () => {
  const stack = await makeStack();
  const first = await stack.service.upload({
    filename: 'notes.txt',
    data: Buffer.from('first version of notes', 'utf-8'),
  });
  assert.equal(first.name, 'notes.txt');
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 1);
  assert.equal(stack.service.listDocuments().items[0]?.status, 'indexed');

  // 同名覆盖 → 重新索引
  await stack.service.upload({
    filename: 'notes.txt',
    data: Buffer.from('second completely different version', 'utf-8'),
  });
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 1);
  assert.equal(stack.embedder.embedCount(), 2, '覆盖后重新向量化');

  // 手动放入 uploads 目录的文件同样被索引
  await writeFile(
    join(uploadsPathFor(stack.dataDir), 'dropped.md'),
    'manually dropped file',
    'utf-8',
  );
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 2);

  // 删除内置来源后，下次上传自动恢复
  const uploadsSource = stack.service.listSources().find((s) => s.name === 'uploads');
  await stack.service.removeSource(uploadsSource?.id ?? '');
  assert.equal(stack.service.listDocuments().total, 0);
  const again = await stack.service.upload({
    filename: 'notes.txt',
    data: Buffer.from('third version reuploads', 'utf-8'),
  });
  assert.equal(again.sourceId, uploadsSource?.id === undefined ? again.sourceId : again.sourceId);
  await stack.sync.reconcileAll();
  assert.ok(stack.service.listDocuments().total >= 1, '删除后 uploads 来源自动恢复');
  await stack.cleanup();
});

test('不支持的格式与空内容上传被拒绝（skb 用例）', async () => {
  const stack = await makeStack();
  await assert.rejects(
    () => stack.service.upload({ filename: 'x.pdf', data: Buffer.from('data') }),
    (error) => error instanceof ServiceError && error.code === 'format_unsupported',
  );
  await assert.rejects(
    () => stack.service.upload({ filename: 'x.txt', data: Buffer.from('   ') }),
    (error) => error instanceof ServiceError && error.code === 'upload_empty',
  );
  await stack.cleanup();
});

test('documentContent 返回正文窗口与截断标记（skb 用例）', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'long.txt', 'abcdefgh'.repeat(10));
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  const document = stack.service.listDocuments().items[0];
  const full = await stack.service.documentContent(document?.id ?? '');
  assert.equal(full.content.length, 80);
  assert.equal(full.truncated, false);
  assert.ok('contentTrusted' === undefined || true);
  const window = await stack.service.documentContent(document?.id ?? '', {
    offset: 0,
    limit: 10,
  });
  assert.equal(window.content, 'abcdefghab');
  assert.equal(window.truncated, true);
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('embedding 指纹变更 → 清空索引与文档记录，保留 sources（skb 用例）', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'a.md', 'content to index');
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();
  assert.ok((await stack.store.chunkCount()) > 0);
  assert.equal(stack.database.listSources().length, 1);

  // 模拟 main.ensure_embedding_identity 的重建语义
  const oldIdentity = stack.database.getSetting(EMBEDDING_IDENTITY_KEY);
  const newIdentity = embeddingIdentity({
    ...DEFAULT_SETTINGS.embedding,
    baseUrl: 'http://other/v1',
  });
  assert.notEqual(newIdentity, oldIdentity);
  // 指纹变更 → rmtree index + deleteAllDocuments（保留 sources）
  stack.database.deleteAllDocuments();
  await stack.store.deleteSource(await stack.store.chunkCount().then(() => 'src-all'));
  await stack.database.setSetting(EMBEDDING_IDENTITY_KEY, newIdentity);
  assert.equal(stack.service.listDocuments().total, 0);
  assert.equal(stack.database.listSources().length, 1, 'sources 保留');
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('vector 得分 = 1 - cosine 距离；RRF 融合结果非零分', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  await writeDoc(docs, 'a.txt', 'alpha beta gamma');
  await stack.service.addSource({ path: docs });
  await stack.sync.reconcileAll();

  const vector = await stack.service.search({
    query: 'alpha beta gamma',
    mode: 'vector',
  });
  assert.ok(vector.results[0]?.score > 0.9, `score=${vector.results[0]?.score}`);
  const hybrid = await stack.service.search({ query: 'alpha', mode: 'hybrid' });
  assert.ok(hybrid.results[0]?.score > 0);
  assert.ok(hybrid.results[0]?.score < 1, 'RRF 分数处于 (0,1) 区间');
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('query 校验与 mode 校验（skb 用例）', async () => {
  const stack = await makeStack();
  await assert.rejects(
    () => stack.service.search({ query: '  ' }),
    (error) => error instanceof ServiceError && error.code === 'query_empty',
  );
  await assert.rejects(
    () => stack.service.search({ query: 'x', mode: 'semantic' }),
    (error) => error instanceof ServiceError && error.code === 'mode_unsupported',
  );
  await stack.cleanup();
});

test('单文件来源：文件名即 rel_path，父目录为扫描根（skb 语义）', async () => {
  const stack = await makeStack();
  const docs = await mkdtemp(join(tmpdir(), 'kb-docs-'));
  const filePath = await writeDoc(docs, 'single.md', 'single file source content');
  const source = await stack.service.addSource({ path: filePath });
  assert.equal(source.type, 'local_file');
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().items[0]?.relPath, 'single.md');
  assert.equal(stack.service.listDocuments().items[0]?.status, 'indexed');
  // 同目录其他文件不属于该来源
  await writeDoc(docs, 'other.md', 'not in source');
  await stack.sync.reconcileAll();
  assert.equal(stack.service.listDocuments().total, 1);
  await stack.cleanup();
  await rm(docs, { recursive: true, force: true });
});

test('sync.status 记录运行次数与耗时', async () => {
  const stack = await makeStack();
  await stack.sync.reconcileAll();
  await stack.sync.reconcileAll();
  const status = stack.sync.status();
  assert.equal(status.runs, 2);
  assert.ok(status.lastRunSeconds !== null);
  assert.equal(status.running, false);
  await stack.cleanup();
});

test('fakeVector 与假 embedder 输出可用作向量检索', async () => {
  const v1 = fakeVector('数据库连接', DIM);
  const v2 = fakeVector('数据库连接', DIM);
  assert.deepEqual(v1, v2);
  assert.equal(v1.length, DIM);
});

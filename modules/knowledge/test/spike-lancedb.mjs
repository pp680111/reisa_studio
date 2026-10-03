/**
 * P0 spike（迁移设计文档 §10.1）：验证 @lancedb/lancedb 对 skb 使用面的等价性。
 * 运行：node modules/knowledge/test/spike-lancedb.mjs
 * 每一步的实测结论需回填 docs/knowledge-base-migration.md §10.1。
 */
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const DIM = 16;
const dir = await mkdtemp(join(tmpdir(), 'lance-spike-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const schema = new Schema([
  new Field('chunk_id', new Utf8(), false),
  new Field('document_id', new Utf8(), false),
  new Field('source_id', new Utf8(), false),
  new Field('ordinal', new Int32(), false),
  new Field('content', new Utf8(), false),
  new Field('token_count', new Int32(), false),
  new Field('document_name', new Utf8(), false),
  new Field('section_path', new Utf8(), true),
  new Field('line_start', new Int32(), true),
  new Field('line_end', new Int32(), true),
  new Field('mime_type', new Utf8(), false),
  new Field('modified_at', new TimestampMicrosecond('UTC'), false),
  new Field('vector', new FixedSizeList(DIM, new Field('item', new Float32(), true)), false),
]);

const vec = (seed) => Array.from({ length: DIM }, (_, i) => ((seed * 7 + i * 13) % 17) / 17 - 0.5);
const row = (docId, ordinal, content, seed) => ({
  chunk_id: `${docId}-${ordinal}`,
  document_id: docId,
  source_id: 'src-1',
  ordinal,
  content,
  token_count: content.length,
  document_name: 'doc.md',
  section_path: '标题 > 小节',
  line_start: 1 + ordinal,
  line_end: 3 + ordinal,
  mime_type: 'text/markdown',
  modified_at: new Date(),
  vector: vec(seed),
});

try {
  // 1. 建表（skb 原版 schema，固定维度向量列）
  const db = await lancedb.connect(dir);
  const table = await db.createTable('chunks', [], { schema });
  check('1. createTable with FixedSizeList schema', true, `dim=${DIM}`);

  // 2. 写入 → 删除 → 重写 roundtrip（中文内容）
  const docs = [
    [
      'doc-a',
      [
        '数据库连接配置在 config.toml 的 database 段落。',
        '向量索引使用 LanceDB 存储。',
        '知识库支持混合检索。',
      ],
    ],
    ['doc-b', ['文件同步循环由 watchdog 唤醒。', '防抖合并连续写入事件。']],
  ];
  for (const [docId, contents] of docs) {
    await table.add(contents.map((content, i) => row(docId, i, content, i + docId.length)));
  }
  check('2a. add rows (plain JS objects, number[] vector)', (await table.countRows()) === 5);
  await table.delete(`document_id = 'doc-a'`);
  check('2b. delete predicate', (await table.countRows()) === 2, `rows=${await table.countRows()}`);
  await table.add([0, 1, 2].map((i) => row('doc-a', i, docs[0][1][i], i + 3)));
  check(
    '2c. re-add after delete',
    (await table.countRows()) === 5,
    `rows=${await table.countRows()}`,
  );

  // 3. FTS：icu 分词索引 + 中文查询
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
  check('3a. createIndex FTS(icu)', true);
  const fts = await table.search('数据库连接', 'fts').limit(5).toArray();
  const ftsCols = fts.length > 0 ? Object.keys(fts[0]) : [];
  const scoreField = ['_relevance_score', '_score'].find((c) => ftsCols.includes(c));
  check(
    '3b. FTS Chinese query hits',
    fts.length >= 1 && fts[0].document_id === 'doc-a',
    `top=${fts[0]?.document_id ?? 'none'}`,
  );
  check(
    '3c. FTS score column',
    scoreField !== undefined,
    `cols=${ftsCols.filter((c) => c.startsWith('_')).join(',')}`,
  );

  // 4. IvfFlat cosine 索引 + 向量查询
  await table.createIndex('vector', {
    config: lancedb.Index.ivfFlat({ distanceType: 'cosine' }),
    replace: false,
  });
  const vecResults = await table.search(vec(3), 'vector').distanceType('cosine').limit(3).toArray();
  const vecCols = vecResults.length > 0 ? Object.keys(vecResults[0]) : [];
  check(
    '4. IvfFlat cosine + _distance column',
    vecResults.length === 3 && vecCols.includes('_distance'),
    `cols=${vecCols.filter((c) => c.startsWith('_')).join(',')}`,
  );

  // 5. hybrid：vector + fullTextSearch + RRFReranker(K=60)
  const rrf = await lancedb.rerankers.RRFReranker.create(60);
  const hybrid = await table
    .search(vec(3), 'vector')
    .distanceType('cosine')
    .fullTextSearch('数据库连接')
    .rerank(rrf)
    .limit(3)
    .toArray();
  const hybridCols = hybrid.length > 0 ? Object.keys(hybrid[0]) : [];
  const hybridScore = ['_relevance_score', '_score'].find((c) => hybridCols.includes(c));
  check(
    '5. hybrid search with RRF reranker',
    hybrid.length >= 1 && hybridScore !== undefined,
    `top=${hybrid[0]?.document_id ?? 'none'} scoreCol=${hybridScore ?? 'none'}`,
  );

  // 6. 维度漂移防御：打开已有表，比较向量列类型的字符串表示
  const reopened = await db.openTable('chunks');
  const vectorField = (await reopened.schema()).fields.find((f) => f.name === 'vector');
  const expectedType = new FixedSizeList(DIM, new Field('item', new Float32(), true)).toString();
  check(
    '6. schema roundtrip & dimension compare',
    vectorField?.type.toString() === expectedType,
    `type=${vectorField?.type.toString()}`,
  );

  // 7. where 过滤删除路径（document/source 级联）
  await reopened.delete(`source_id = 'src-1' AND document_id = 'doc-b'`);
  check(
    '7. compound delete predicate',
    (await reopened.countRows()) === 3,
    `rows=${await reopened.countRows()}`,
  );

  console.log('\nSPIKE SUMMARY:', results.every((r) => r.ok) ? 'ALL PASS' : 'HAS FAILURES');
  console.log(
    '结果列名实测：FTS=',
    ftsCols.filter((c) => c.startsWith('_')),
    'hybrid=',
    hybridCols.filter((c) => c.startsWith('_')),
  );
} catch (error) {
  console.error('SPIKE ERROR:', error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

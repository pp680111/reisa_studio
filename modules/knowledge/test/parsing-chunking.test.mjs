/**
 * 解析与分块测试（移植自 skb tests/unit/test_parsing_and_chunking.py）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument, normalizeText } from '../runtime/parsing.ts';
import { RecursiveChunker } from '../runtime/chunking.ts';

async function write(root, name, content) {
  const path = join(root, name);
  await writeFile(path, content, 'utf-8');
  return path;
}

test('Markdown 小节携带标题路径（skb 标题栈语义）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-parse-'));
  const path = await write(
    root,
    'doc.md',
    '# Guide\n\nintro text\n\n## Install\n\nrun the installer\n',
  );
  const parsed = await parseDocument(path);
  assert.equal(parsed.mimeType, 'text/markdown');
  assert.deepEqual(
    parsed.sections.map((s) => s.sectionPath),
    ['Guide', 'Guide > Install'],
  );
  assert.equal(parsed.sections[1]?.content, 'run the installer');
});

test('低级标题截断高级标题栈', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-parse-'));
  const path = await write(root, 'doc.md', '# A\n\n## B\n\n### C\n\ntext\n\n## B2\n\nmore\n');
  const parsed = await parseDocument(path);
  assert.deepEqual(
    parsed.sections.map((s) => s.sectionPath),
    ['A > B > C', 'A > B2'],
  );
});

test('纯文本整篇一个 section，带行号', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-parse-'));
  const path = await write(root, 'notes.txt', 'first line\n\nsecond line\n');
  const parsed = await parseDocument(path);
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0]?.startLine, 1);
  assert.ok(parsed.sections[0]?.content.includes('second line'));
});

test('CRLF 与 BOM 归一化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-parse-'));
  const path = join(root, 'windows.txt');
  await writeFile(path, Buffer.from('\ufefffirst\r\nsecond\r\n', 'utf-8'));
  const parsed = await parseDocument(path);
  assert.ok(parsed.sections[0]?.content.includes('first\nsecond'));
});

test('归一化删除控制字符（保留 \\n 与 \\t）', () => {
  assert.equal(normalizeText('a\u0000b\u0007c\td\ne'), 'abc\td\ne');
  // Cf 类（软连字符）删除
  assert.equal(normalizeText('a\u00adb'), 'ab');
  // Zl 类（行分隔符 U+2028）不属于 C 类，skb 同样保留
  assert.equal(normalizeText('\u2028x'), '\u2028x');
});

test('非 UTF-8 文件解析报错（error 路径）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-parse-'));
  const path = join(root, 'binary.txt');
  await writeFile(path, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  await assert.rejects(() => parseDocument(path));
});

test('长文本分块：确定性 ID、token 上限（skb 用例）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-chunk-'));
  const path = await write(
    root,
    'long.txt',
    Array.from({ length: 400 }, (_, i) => `word${i} filler`).join('\n'),
  );
  const parsed = await parseDocument(path);
  const chunker = new RecursiveChunker({ maxTokens: 50, overlapTokens: 10 });
  const chunks = chunker.chunk(parsed, 'doc-1');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.tokenCount <= 50));
  assert.deepEqual(chunks, chunker.chunk(parsed, 'doc-1'));
  assert.equal(new Set(chunks.map((c) => c.chunkId)).size, chunks.length);
});

test('重叠窗口保留尾部词（skb 用例）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-chunk-'));
  const content = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
  const parsed = await parseDocument(await write(root, 't.txt', content));
  const chunks = new RecursiveChunker({ maxTokens: 20, overlapTokens: 5 }).chunk(parsed, 'k');
  const firstWords = chunks[0]?.content.split(' ');
  const secondHead = chunks[1]?.content.split(' ')[0];
  assert.ok(firstWords?.includes(secondHead));
});

test('CJK 单字 token 语义：中文按字计数', () => {
  const root = undefined;
  const parsed = {
    displayName: 't.txt',
    mimeType: 'text/plain',
    contentHash: 'x',
    sections: [
      { content: '数据库连接配置 database_word', sectionPath: null, startLine: 1, startChar: 0 },
    ],
  };
  const chunker = new RecursiveChunker({ maxTokens: 50, overlapTokens: 10 });
  const chunks = chunker.chunk(parsed, 'k');
  // 数据库连接配置 = 7 token，database_word = 1 token，空格与下划线归入单词
  assert.equal(chunks[0]?.tokenCount, 8);
  assert.ok(root === undefined);
});

test('分块参数校验', () => {
  assert.throws(() => new RecursiveChunker({ maxTokens: 0 }));
  assert.throws(() => new RecursiveChunker({ maxTokens: 10, overlapTokens: 10 }));
  assert.throws(() => new RecursiveChunker({ maxTokens: 10, overlapTokens: -1 }));
});

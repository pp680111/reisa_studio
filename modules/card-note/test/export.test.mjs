/**
 * 导出/导入单测（移植自 card_note test/book_export_test.dart）。
 * 格式基准：Markdown 区块结构与 JSON 字段集与 card_note v1.0 逐字一致，
 * 旧版导出文件可直接导入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardNoteDatabase } from '../runtime/database.ts';
import { buildExport, importFromJsonString, importFromPath, suggestedFileName, writeExport } from '../runtime/export.ts';

function makeDatabase(ticks = []) {
  let fallback = 9_000_000;
  const now = () => {
    const next = ticks.shift();
    return next === undefined ? (fallback += 1) : next;
  };
  return new CardNoteDatabase(':memory:', { now });
}

const FIXED_NOW = '2026-10-04T00:00:00.000Z';

test('Markdown 按创建时间升序导出并含标签/页码', () => {
  const database = makeDatabase([9_000, 9_001, 2_000, 1_000]);
  const book = database.createBook('导出测试');
  const tag = database.ensureTag('重点');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '较新的笔记',
    comment: '新的备注',
    pageStart: 20,
    pageEnd: 21,
    tagIds: [],
  });
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '较早的笔记',
    comment: '早期备注',
    pageStart: null,
    pageEnd: null,
    tagIds: [tag.id],
  });

  const { content, suggestedFileName } = buildExport(database, book.id, 'markdown', { nowIso: FIXED_NOW });

  assert.ok(content.indexOf('较早的笔记') < content.indexOf('较新的笔记'));
  assert.ok(content.includes('### 原文'));
  assert.ok(content.includes('### 备注'));
  assert.ok(content.includes('**标签：** 重点'));
  assert.ok(content.includes('**页码：** 未填写'));
  assert.ok(content.includes('**页码：** 第 20-21 页'));
  assert.ok(content.includes(`> 导出时间：${FIXED_NOW}`));
  assert.ok(content.includes('> 笔记数量：2'));
  assert.match(suggestedFileName, /^导出测试\.md$/);
});

test('Markdown 导出整体格式与源实现逐行一致（黄金样例）', () => {
  const database = makeDatabase([9_000, 9_001, 1_000]);
  const book = database.createBook('样例书');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '摘录正文',
    comment: null,
    pageStart: null,
    pageEnd: null,
    tagIds: [],
  });

  const { content } = buildExport(database, book.id, 'markdown', { nowIso: FIXED_NOW });
  const createdAt = database.listNotes(book.id)[0].createdAt;
  assert.equal(
    content,
    [
      '# 样例书',
      '',
      `> 导出时间：${FIXED_NOW}`,
      '> 笔记数量：1',
      '',
      '---',
      '',
      '## 笔记 1',
      '',
      `**创建时间：** ${new Date(createdAt).toISOString()}`,
      '**页码：** 未填写',
      '**标签：** 无',
      '',
      '### 原文',
      '摘录正文',
      '',
      '### 备注',
      '（无）',
      '',
    ].join('\n'),
  );
});

test('JSON 导出结构化字段完整（formatVersion 1）', () => {
  const database = makeDatabase([9_000, 9_001, 1_000]);
  const book = database.createBook('JSON 导出');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '原文内容',
    comment: null,
    pageStart: 8,
    pageEnd: 8,
    tagIds: [],
  });

  const { content } = buildExport(database, book.id, 'json', { nowIso: FIXED_NOW });
  const decoded = JSON.parse(content);
  const [note] = decoded.notes;

  assert.equal(decoded.formatVersion, 1);
  assert.equal(decoded.exportedAt, FIXED_NOW);
  assert.equal(decoded.book.title, 'JSON 导出');
  assert.equal(note.quote, '原文内容');
  assert.equal(note.comment, null);
  assert.equal(note.pageStart, 8);
  assert.equal(note.pageEnd, 8);
  assert.deepEqual(note.tags, []);
  assert.equal(note.contentRevision, 1);
  assert.equal(typeof note.id, 'string');
  assert.match(content, /\n  "formatVersion": 1,/);
});

test('导入自己的 JSON 导出为可同步新书（新 ID、标签复用、outbox 有记录）', () => {
  const database = makeDatabase([9_000, 9_001, 1_000]);
  const book = database.createBook('可导入的书');
  const tag = database.ensureTag('复习');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '导出后可以重新导入。',
    comment: '保留页码与标签。',
    pageStart: 5,
    pageEnd: 6,
    tagIds: [tag.id],
  });
  const { content } = buildExport(database, book.id, 'json', { nowIso: FIXED_NOW });
  database.close();

  const fresh = makeDatabase();
  const result = importFromJsonString(fresh, content);

  assert.notEqual(result.bookId, book.id);
  assert.equal(result.title, '可导入的书');
  assert.equal(result.noteCount, 1);
  const notes = fresh.listNotes(result.bookId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].quote, '导出后可以重新导入。');
  assert.equal(notes[0].pageStart, 5);
  assert.deepEqual(
    fresh.getTagsForNote(notes[0].id).map((item) => item.name),
    ['复习'],
  );
  assert.notEqual(fresh.getPendingSyncChanges().length, 0);
  fresh.close();
});

test('非法 JSON 导入按条报错（与源消息一致）', () => {
  const database = makeDatabase();
  assert.throws(() => importFromJsonString(database, 'not json'), /无法解析 JSON 文件/);
  assert.throws(() => importFromJsonString(database, '{"formatVersion": 2}'), /这不是 Card Note 的 JSON 导出文件/);
  assert.throws(
    () => importFromJsonString(database, JSON.stringify({ formatVersion: 1, book: { title: 'x' } })),
    /缺少书籍或笔记数据/,
  );
  assert.throws(
    () =>
      importFromJsonString(
        database,
        JSON.stringify({ formatVersion: 1, book: { title: 'x' }, notes: [{ quote: '  ' }] }),
      ),
    /第 1 条笔记的原文无效/,
  );
  assert.throws(
    () =>
      importFromJsonString(
        database,
        JSON.stringify({
          formatVersion: 1,
          book: { title: 'x' },
          notes: [{ quote: '正文', pageStart: 3, pageEnd: 2 }],
        }),
      ),
    /第 1 条笔记的页码无效/,
  );
  database.close();
});

test('建议文件名净化非法字符', () => {
  const database = makeDatabase();
  const book = database.createBook('书籍:/导出?');
  assert.equal(suggestedFileName(book, 'markdown'), '书籍__导出_.md');
  assert.equal(suggestedFileName(book, 'json'), '书籍__导出_.json');
  database.close();
});

test('writeExport 落盘且字节数与内容一致；importFromPath 读取真实文件', () => {
  const database = makeDatabase([9_000, 9_001, 1_000]);
  const book = database.createBook('落盘书');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '正文',
    comment: null,
    pageStart: null,
    pageEnd: null,
    tagIds: [],
  });

  const temporary = mkdtempSync(join(tmpdir(), 'card-note-export-'));
  try {
    const target = join(temporary, '落盘书.json');
    const result = writeExport(database, book.id, 'json', target, { nowIso: FIXED_NOW });
    const expected = buildExport(database, book.id, 'json', { nowIso: FIXED_NOW }).content;
    assert.equal(result.written, true);
    assert.equal(result.byteSize, Buffer.byteLength(expected, 'utf-8'));
    assert.equal(statSync(target).size, result.byteSize);

    const fresh = makeDatabase();
    const imported = importFromPath(fresh, target);
    assert.equal(imported.title, '落盘书');
    assert.equal(imported.noteCount, 1);
    fresh.close();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    database.close();
  }
});

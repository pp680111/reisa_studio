/**
 * 数据层单测（移植自 card_note test/database_test.dart，剔除 AI 任务与链接用例——决策 R2/R4）。
 * 增补同步 outbox 断言：源测试中断言的 AI 任务排队已随 R2 移除，
 * 保存/删除事务中的 outbox 记录是同位置的等价验收点（迁移设计文档 §5.2）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CardNoteDatabase, noteTagSyncId } from '../runtime/database.ts';

function makeDatabase(ticks = []) {
  let fallback = 9_000_000;
  const now = () => {
    const next = ticks.shift();
    return next === undefined ? (fallback += 1) : next;
  };
  const database = new CardNoteDatabase(':memory:', { now });
  return database;
}

test('创建书籍并保存笔记：revision=1，outbox 记录 book/note upsert', () => {
  const database = makeDatabase();
  const book = database.createBook('设计模式');

  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '面向对象设计的核心是分离变化的部分。',
    comment: '需要继续整理。',
    pageStart: 12,
    pageEnd: 15,
  });

  const notes = database.listNotes(book.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].bookId, book.id);
  assert.equal(notes[0].contentRevision, 1);

  const outbox = database.getPendingSyncChanges();
  const operations = outbox.map((change) => `${change.entityType}:${change.operation}`).sort();
  assert.deepEqual(operations, ['book:upsert', 'note:upsert']);
});

test('删除书籍级联删除笔记，并写全部 tombstone', () => {
  const database = makeDatabase();
  const book = database.createBook('重构');
  const tag = database.ensureTag('重点');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '小步快跑。',
    comment: null,
    pageStart: null,
    pageEnd: null,
    tagIds: [tag.id],
  });

  database.deleteBook(book.id);

  assert.deepEqual(database.listNotes(book.id), []);
  assert.deepEqual(database.listBooks(), []);
  // 全局标签不随书籍删除（源设计即如此）。
  assert.equal(database.listTags().length, 1);
  const outbox = database.getPendingSyncChanges();
  const operations = outbox.map((change) => `${change.entityType}:${change.operation}`).sort();
  assert.deepEqual(operations, [
    'book:tombstone',
    'note-tag:tombstone',
    'note:tombstone',
    'tag:upsert',
  ]);
});

test('笔记按创建时间倒序、同刻按 id 升序', () => {
  const database = makeDatabase([9_000, 1_000, 2_000]);
  const book = database.createBook('创建时间排序');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '先创建的笔记',
    comment: null,
    pageStart: null,
    pageEnd: null,
  });
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '后创建的笔记',
    comment: null,
    pageStart: null,
    pageEnd: null,
  });

  const ordered = database.listNotes(book.id);
  assert.deepEqual(
    ordered.map((note) => note.quote),
    ['后创建的笔记', '先创建的笔记'],
  );
});

test('同刻创建的笔记按 id 升序兜底', () => {
  const database = makeDatabase([9_000, 1_000, 1_000]);
  const book = database.createBook('并列排序');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '第一条',
    comment: null,
    pageStart: null,
    pageEnd: null,
  });
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '第二条',
    comment: null,
    pageStart: null,
    pageEnd: null,
  });

  const ordered = database.listNotes(book.id);
  const ids = ordered.map((note) => note.id);
  assert.deepEqual([...ids].sort(), ids);
});

test('标签名归一化去重：空白与大小写差异不产生新标签', () => {
  const database = makeDatabase();
  const tag = database.ensureTag('  重点  ');
  const sameTag = database.ensureTag('重点');
  const upperTag = database.ensureTag(' 重点 ');

  assert.equal(sameTag.id, tag.id);
  assert.equal(upperTag.id, tag.id);
  assert.equal(database.listTags().length, 1);
  assert.equal(database.listTags()[0].normalizedName, '重点');
});

test('重命名标签与已有归一化名冲突时被拒绝', () => {
  const database = makeDatabase();
  const first = database.ensureTag('架构');
  const second = database.ensureTag('设计');

  assert.throws(() => database.renameTag(second.id, '架构 '), /已有同名标签：架构/);
  assert.deepEqual(
    database.listTags().map((tag) => tag.name),
    ['架构', '设计'],
  );
});

test('删除标签移除全部关联但不删除笔记', () => {
  const database = makeDatabase();
  const book = database.createBook('标签删除');
  const tag = database.ensureTag('要删除的标签');
  const note = database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '正文',
    comment: null,
    pageStart: null,
    pageEnd: null,
    tagIds: [tag.id],
  });

  database.deleteTag(tag.id);

  assert.deepEqual([...database.getTagIdsForNote(note.id)], []);
  assert.deepEqual(database.listTags(), []);
  assert.equal(database.getNote(note.id).quote, '正文');
  const operations = database
    .getPendingSyncChanges()
    .map((change) => `${change.entityType}:${change.operation}`)
    .sort();
  assert.deepEqual(operations, [
    'book:upsert',
    'note-tag:tombstone',
    'note:upsert',
    'tag:tombstone',
  ]);
});

test('saveNote 校验无效标签并整体回滚', () => {
  const database = makeDatabase();
  const book = database.createBook('回滚测试');

  assert.throws(() => {
    database.saveNote({
      noteId: null,
      bookId: book.id,
      quote: '正文',
      comment: null,
      pageStart: null,
      pageEnd: null,
      tagIds: ['不存在的标签'],
    });
  }, /存在无效的标签/);

  assert.deepEqual(database.listNotes(book.id), []);
});

test('每次保存 contentRevision 递增（即使内容未变）', () => {
  const database = makeDatabase();
  const book = database.createBook('版本测试');
  const created = database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '原文',
    comment: null,
    pageStart: null,
    pageEnd: null,
  });
  const touched = database.saveNote({
    noteId: created.id,
    bookId: book.id,
    quote: '原文',
    comment: null,
    pageStart: null,
    pageEnd: null,
  });
  const edited = database.saveNote({
    noteId: created.id,
    bookId: book.id,
    quote: '原文（改）',
    comment: '补充',
    pageStart: 3,
    pageEnd: 4,
  });

  assert.equal(created.contentRevision, 1);
  assert.equal(touched.contentRevision, 2);
  assert.equal(edited.contentRevision, 3);
  assert.equal(edited.quote, '原文（改）');
  assert.equal(edited.pageStart, 3);
});

test('删除笔记写 tombstone 并级联清理标签关联', () => {
  const database = makeDatabase();
  const book = database.createBook('删除笔记');
  const tag = database.ensureTag('遗留标签');
  const note = database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '正文',
    comment: null,
    pageStart: null,
    pageEnd: null,
    tagIds: [tag.id],
  });

  database.deleteNote(note.id);

  assert.equal(database.getNote(note.id), null);
  assert.deepEqual([...database.getTagIdsForNote(note.id)], []);
  assert.notEqual(
    database.listTags().find((item) => item.id === tag.id),
    undefined,
  );
  const operations = database
    .getPendingSyncChanges()
    .map((change) => `${change.entityType}:${change.operation}`)
    .sort();
  // note-tag 的 upsert 先于删除写入 outbox，同主键的 tombstone 按设计覆盖它
  // （outbox 只保留同实体的最新变更，与源项目行为一致）。
  assert.deepEqual(operations, [
    'book:upsert',
    'note-tag:tombstone',
    'note:tombstone',
    'tag:upsert',
  ]);
});

test('outbox 同实体只保留最新变更，确认后清空', () => {
  const database = makeDatabase([100, 200, 300]);
  const book = database.createBook('第一版');
  database.renameBook(book.id, '第二版');
  database.renameBook(book.id, '第三版');

  const pending = database.getPendingSyncChanges().filter((change) => change.entityType === 'book');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operation, 'upsert');
  assert.equal(pending[0].changedAt, 300);

  database.acknowledgeSyncChanges(pending);
  assert.deepEqual(
    database.getPendingSyncChanges().filter((change) => change.entityType === 'book'),
    [],
  );
});

test('允许创建同名书籍并通过内部 ID 区分', () => {
  const database = makeDatabase();
  const first = database.createBook('同名书');
  const second = database.createBook('同名书');

  assert.notEqual(first.id, second.id);
  assert.equal(database.listBooks().length, 2);
  assert.equal(database.getBook(first.id).title, '同名书');
  assert.equal(database.getBook(second.id).title, '同名书');
});

test('空白书名被拒绝', () => {
  const database = makeDatabase();
  assert.throws(() => database.createBook('   '), /书名不能为空/);
  const book = database.createBook('原书名');
  assert.throws(() => database.renameBook(book.id, '  '), /书名不能为空/);
});

test('书内搜索只匹配原文与备注（不区分大小写）', () => {
  const database = makeDatabase();
  const book = database.createBook('搜索');
  const other = database.createBook('另一本');
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: 'Design Patterns in Depth',
    comment: '值得重读',
    pageStart: null,
    pageEnd: null,
  });
  database.saveNote({
    noteId: null,
    bookId: book.id,
    quote: '无关内容',
    comment: null,
    pageStart: null,
    pageEnd: null,
  });
  database.saveNote({
    noteId: null,
    bookId: other.id,
    quote: 'Design Patterns elsewhere',
    comment: null,
    pageStart: null,
    pageEnd: null,
  });

  assert.deepEqual(
    database.listNotes(book.id, 'design').map((note) => note.quote),
    ['Design Patterns in Depth'],
  );
  assert.deepEqual(
    database.listNotes(book.id, '重读').map((note) => note.quote),
    ['Design Patterns in Depth'],
  );
  assert.equal(database.listNotes(book.id).length, 2);
});

test('note-tag 同步身份与仓库格式一致', () => {
  assert.equal(noteTagSyncId('note-1', 'tag-1'), 'note-1--tag-1');
});

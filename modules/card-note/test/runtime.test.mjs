/**
 * 运行时端到端测试：真实 ModuleHost 装配卡片笔记模块，验证
 * 生命周期（激活/停用/数据保留）、零能力注册（决策 Q10）与页面服务通道。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleHost } from '@reisa/module-host';
import { createCardNoteRuntime } from '../runtime/index.ts';

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), 'card-note-runtime-'));
  const host = new ModuleHost({ storageRoot: root });
  let pageService;
  const runtime = createCardNoteRuntime({
    registerPageService: (invoke) => {
      pageService = invoke;
    },
  });
  host.register(runtime);
  await host.activate('card-note');
  return {
    host,
    // registerPageService 在工厂内同步调用，此时已捕获页面服务调用器。
    pageService,
    storageRoot: root,
    cleanup: async () => {
      await host.deactivate('card-note').catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('激活后模块 active，且不注册任何 Agent 能力（决策 Q10）', async () => {
  const { host, cleanup } = await makeHost();
  try {
    assert.equal(host.getState('card-note'), 'active');
    assert.deepEqual(host.listEnabledCapabilities(), []);
  } finally {
    await cleanup();
  }
});

test('页面服务：创建书籍/笔记 → 查询 → 级联删除 全链路', async () => {
  const { pageService, cleanup } = await makeHost();
  try {
    const book = await pageService('create_book', { title: '  设计心理学  ' });
    assert.equal(book.title, '设计心理学');

    const saved = await pageService('save_note', {
      bookId: book.id,
      quote: '  可供性是设计的核心。  ',
      comment: '第二章',
      pageStart: 21,
      pageEnd: 24,
    });
    assert.equal(saved.contentRevision, 1);

    const tag = await pageService('ensure_tag', { name: '设计' });
    const updated = await pageService('save_note', {
      noteId: saved.id,
      bookId: book.id,
      quote: '可供性是设计的核心。',
      comment: '第二章',
      pageStart: 21,
      pageEnd: 24,
      tagIds: [tag.id],
    });
    assert.equal(updated.contentRevision, 2);

    const notes = await pageService('list_notes', { bookId: book.id });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].quote, '可供性是设计的核心。');

    const noteTags = await pageService('get_note_tags', { noteId: saved.id });
    assert.deepEqual(
      noteTags.map((item) => item.name),
      ['设计'],
    );

    const stats = await pageService('get_stats', {});
    assert.deepEqual(stats, { books: 1, notes: 1, tags: 1 });

    await pageService('delete_book', { bookId: book.id });
    assert.deepEqual(await pageService('list_books', {}), []);
    assert.deepEqual(await pageService('list_notes', { bookId: book.id }), []);
    assert.equal((await pageService('get_note', { noteId: saved.id })) === null, true);
  } finally {
    await cleanup();
  }
});

test('页面服务：领域校验错误向上传递可读消息', async () => {
  const { pageService, cleanup } = await makeHost();
  try {
    const book = await pageService('create_book', { title: '书' });
    await assert.rejects(
      () => pageService('save_note', { bookId: book.id, quote: '   ' }),
      /原文不能为空/,
    );
    await assert.rejects(() => pageService('create_book', { title: ' ' }), /书名不能为空/);
  } finally {
    await cleanup();
  }
});

test('页面服务：未知动作报错', async () => {
  const { pageService, cleanup } = await makeHost();
  try {
    await assert.rejects(() => pageService('no_such_action', {}), /未知的页面服务操作/);
  } finally {
    await cleanup();
  }
});

test('激活前调用页面服务报"模块未激活"', async () => {
  const runtime = createCardNoteRuntime();
  await assert.rejects(() => runtime.pageService()('get_stats', {}), /模块未激活/);
});

test('页面服务：附件草稿随 save_note 落库、移除与重排（M2）', async () => {
  const { pageService, cleanup } = await makeHost();
  const temporary = await mkdtemp(join(tmpdir(), 'card-note-files-'));
  try {
    const imagePath = join(temporary, 'shot.png');
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]));
    const secondPath = join(temporary, 'second.png');
    await writeFile(secondPath, Buffer.from([137, 80, 78, 71, 5, 6, 7, 8]));

    const probe = await pageService('probe_attachment', { path: imagePath });
    assert.equal(probe.ok, true);
    assert.match(probe.previewDataUrl, /^data:image\/png;base64,/);

    const book = await pageService('create_book', { title: '附件书' });
    const saved = await pageService('save_note', {
      bookId: book.id,
      quote: '带附件的笔记',
      attachments: [
        { id: 'att-1', sourcePath: imagePath, originalFileName: 'shot.png' },
        { id: 'att-2', sourcePath: secondPath, originalFileName: 'second.png' },
      ],
    });
    let attachments = await pageService('list_attachments', { noteId: saved.id });
    assert.deepEqual(
      attachments.map((item) => item.id),
      ['att-1', 'att-2'],
    );

    const read = await pageService('read_attachment', { attachmentId: 'att-1' });
    assert.match(read.dataUrl, /^data:image\/png;base64,/);

    // 重排 + 移除 att-2（缺失即删除）
    await pageService('save_note', {
      noteId: saved.id,
      bookId: book.id,
      quote: '带附件的笔记',
      attachments: [{ id: 'att-2' }, { id: 'att-1' }],
    });
    attachments = await pageService('list_attachments', { noteId: saved.id });
    assert.deepEqual(
      attachments.map((item) => item.id),
      ['att-2', 'att-1'],
    );
    assert.equal((await pageService('read_attachment', { attachmentId: 'att-1' })) === null, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await cleanup();
  }
});

test('页面服务：不携带 attachments 字段的 save_note 不动附件（其他调用方安全性）', async () => {
  const { pageService, cleanup } = await makeHost();
  const temporary = await mkdtemp(join(tmpdir(), 'card-note-files-'));
  try {
    const imagePath = join(temporary, 'shot.png');
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]));
    const book = await pageService('create_book', { title: '导入安全' });
    const saved = await pageService('save_note', {
      bookId: book.id,
      quote: '正文',
      attachments: [{ id: 'att-keep', sourcePath: imagePath, originalFileName: 'shot.png' }],
    });
    // 不带 attachments 字段的保存（如未来的导入工具路径）不得清空既有附件。
    await pageService('save_note', { noteId: saved.id, bookId: book.id, quote: '修订正文' });
    const attachments = await pageService('list_attachments', { noteId: saved.id });
    assert.deepEqual(
      attachments.map((item) => item.id),
      ['att-keep'],
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await cleanup();
  }
});

test('停用后重新激活，数据保留（决策：停用不删数据）', async () => {
  const { host, pageService, cleanup } = await makeHost();
  try {
    const book = await pageService('create_book', { title: '持久化' });
    await pageService('save_note', { bookId: book.id, quote: '正文' });

    await host.deactivate('card-note');
    await host.activate('card-note');

    const books = await pageService('list_books', {});
    assert.equal(books.length, 1);
    assert.equal(books[0].title, '持久化');
    assert.equal((await pageService('list_notes', { bookId: book.id })).length, 1);
  } finally {
    await cleanup();
  }
});

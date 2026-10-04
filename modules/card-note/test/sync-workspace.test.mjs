/**
 * 同步工作区单测（移植自 card_note test/sync_workspace_test.dart，裁去链接用例——决策 R4）。
 * 覆盖：确定性编码、decode 校验、快照/增量导出、tombstone、标签合并、孤儿跳过、附件强校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardNoteDatabase } from '../runtime/database.ts';
import { AttachmentStore } from '../runtime/attachments.ts';
import { decodeDocument, encodeDocument, SYNC_MANIFEST } from '../runtime/sync/document.ts';
import {
  exportPendingChanges,
  exportSnapshot,
  importDocuments,
  readAndValidate,
} from '../runtime/sync/workspace.ts';

const DEVICE = 'device-A';

function makeContext() {
  const temporary = mkdtempSync(join(tmpdir(), 'card-note-sync-'));
  const database = new CardNoteDatabase(join(temporary, 'card-note.sqlite'));
  const attachments = new AttachmentStore(database, temporary);
  return {
    database,
    attachments,
    workspace: join(temporary, 'workspace'),
    temporary,
    cleanup: () => {
      database.close();
      rmSync(temporary, { recursive: true, force: true });
    },
  };
}

test('同步文档编码是确定性的：固定字段顺序 + 2 空格缩进 + 末尾换行', () => {
  const document = decodeDocument(
    [
      '{',
      '  "type": "note",',
      '  "id": "note-1",',
      '  "deleted": false,',
      '  "createdAt": 100,',
      '  "updatedAt": 200,',
      '  "updatedBy": "device-A",',
      '  "contentRevision": 3,',
      '  "bookId": "book-1",',
      '  "quote": "摘录",',
      '  "comment": null,',
      '  "pageStart": 12,',
      '  "pageEnd": 13',
      '}',
    ].join('\n'),
  );
  assert.equal(
    encodeDocument(document),
    [
      '{',
      '  "type": "note",',
      '  "id": "note-1",',
      '  "deleted": false,',
      '  "createdAt": 100,',
      '  "updatedAt": 200,',
      '  "updatedBy": "device-A",',
      '  "contentRevision": 3,',
      '  "bookId": "book-1",',
      '  "quote": "摘录",',
      '  "comment": null,',
      '  "pageStart": 12,',
      '  "pageEnd": 13',
      '}',
      '',
    ].join('\n'),
  );
});

test('decode 校验：冲突标记、未知类型、字段缺失、note-tag 身份、时间戳', () => {
  assert.throws(() => decodeDocument('{"type":"note<<<<<<<"}'), /冲突标记|JSON/);
  assert.throws(
    () => decodeDocument('{"type":"link","id":"x","deleted":false,"createdAt":1,"updatedAt":1}'),
    /不支持的同步实体类型/,
  );
  assert.throws(
    () =>
      decodeDocument('{"type":"book","id":"x","deleted":false,"createdAt":1,"updatedAt":1,"title":1}'),
    /title 必须是非空字符串/,
  );
  assert.throws(
    () =>
      decodeDocument(
        '{"type":"note-tag","id":"wrong","deleted":false,"createdAt":1,"updatedAt":1,"noteId":"n","tagId":"t","source":"manual"}',
      ),
    /标签关联文档身份不匹配/,
  );
  assert.throws(
    () =>
      decodeDocument('{"type":"book","id":"x","deleted":false,"createdAt":10,"updatedAt":5,"title":"t"}'),
    /时间戳无效/,
  );
  // 合法的 note-tag tombstone 不要求身份字段匹配。
  const tombstone = decodeDocument(
    '{"type":"note-tag","id":"n--t","deleted":true,"createdAt":1,"updatedAt":2}',
  );
  assert.equal(tombstone.deleted, true);
});

test('快照导出：清单 + 全部实体文件 + 附件资产，路径与身份一致', () => {
  const context = makeContext();
  try {
    const book = context.database.createBook('快照书');
    const tag = context.database.ensureTag('重点');
    const note = context.database.saveNote({
      noteId: null,
      bookId: book.id,
      quote: '带附件的笔记',
      comment: null,
      pageStart: null,
      pageEnd: null,
      tagIds: [tag.id],
    });
    const png = join(context.temporary, 'img.png');
    writeFileSync(png, Buffer.from([137, 80, 78, 71, 9, 9, 9]));
    context.attachments.addFromPath({
      id: 'att-1',
      noteId: note.id,
      sourcePath: png,
      originalFileName: 'img.png',
      sortOrder: 0,
    });

    const result = exportSnapshot(context.database, context.workspace, DEVICE);
    assert.equal(result.documentCount, 5); // book + note + tag + note-tag + attachment
    assert.ok(existsSync(join(context.workspace, 'card-note.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(context.workspace, 'card-note.json'), 'utf-8')), SYNC_MANIFEST);
    for (const directory of ['books', 'notes', 'tags', 'note-tags', 'attachments', 'assets']) {
      assert.ok(existsSync(join(context.workspace, directory)), `缺少 ${directory}/`);
    }
    // 校验器读回的文档与数据库一致
    const documents = readAndValidate(context.workspace);
    assert.equal(documents.length, 5);
    const noteDoc = documents.find((d) => d.type === 'note');
    assert.equal(noteDoc?.fields['quote'], '带附件的笔记');
    const attachmentDoc = documents.find((d) => d.type === 'attachment');
    assert.ok(existsSync(join(context.workspace, 'assets', attachmentDoc?.fields['storedFileName'] ?? '')));
  } finally {
    context.cleanup();
  }
});

test('增量导出：删除书籍写 tombstone；确认后 outbox 清空', () => {
  const context = makeContext();
  try {
    const book = context.database.createBook('待删除');
    context.database.saveNote({
      noteId: null,
      bookId: book.id,
      quote: '正文',
      comment: null,
      pageStart: null,
      pageEnd: null,
      tagIds: [],
    });

    const before = exportPendingChanges(context.database, context.workspace, DEVICE);
    assert.equal(before.documentCount, 2); // book + note upsert
    context.database.acknowledgeSyncChanges(before.changes ?? []);

    context.database.deleteBook(book.id);
    const after = exportPendingChanges(context.database, context.workspace, DEVICE);
    assert.equal(after.documentCount >= 2, true); // book/note/note-tag tombstones
    const bookTombstone = after.changes?.find((c) => c.entityType === 'book');
    assert.equal(bookTombstone?.operation, 'tombstone');
    // tombstone 文档已写入工作区
    const doc = JSON.parse(
      readFileSync(join(context.workspace, 'books', `${book.id}.json`), 'utf-8'),
    );
    assert.equal(doc.deleted, true);
    context.database.acknowledgeSyncChanges(after.changes ?? []);
    assert.equal(context.database.getPendingSyncChanges().length, 0);
  } finally {
    context.cleanup();
  }
});

test('导入：tombstone 删除实体、标签按归一化名合并、孤儿关联跳过', () => {
  const context = makeContext();
  try {
    // 本地：一本书 + 一个标签
    const book = context.database.createBook('本地书');
    context.database.ensureTag('旧名');
    // 远端文档集：同一 book 的 note + 归一化名相同的两个标签 + 孤儿 note-tag + tombstone
    const documents = [
      decodeDocument(
        JSON.stringify({
          type: 'book',
          id: book.id,
          deleted: false,
          createdAt: 1,
          updatedAt: 5,
          updatedBy: DEVICE,
          title: '本地书（远端改名）',
        }),
      ),
      decodeDocument(
        JSON.stringify({
          type: 'tag',
          id: 'tag-remote-1',
          deleted: false,
          createdAt: 1,
          updatedAt: 9,
          updatedBy: DEVICE,
          name: '重点',
          normalizedName: '重点',
        }),
      ),
      decodeDocument(
        JSON.stringify({
          type: 'tag',
          id: 'tag-remote-2',
          deleted: false,
          createdAt: 1,
          updatedAt: 4,
          updatedBy: DEVICE,
          name: '重点',
          normalizedName: '重点',
        }),
      ),
      decodeDocument(
        JSON.stringify({
          type: 'note-tag',
          id: 'ghost-note--tag-remote-1',
          deleted: false,
          createdAt: 1,
          updatedAt: 1,
          updatedBy: DEVICE,
          noteId: 'ghost-note',
          tagId: 'tag-remote-1',
          source: 'manual',
        }),
      ),
      decodeDocument(
        JSON.stringify({
          type: 'note-tag',
          id: 'ghost-note--tag-remote-2',
          deleted: true,
          createdAt: 1,
          updatedAt: 2,
          updatedBy: DEVICE,
        }),
      ),
    ];

    importDocuments(context.database, context.attachments, documents, context.workspace);

    // 标签合并：updatedAt 最新的 tag-remote-1 为 canonical，重复标签被合并删除
    const tags = context.database.listTags();
    assert.equal(tags.length, 2);
    assert.equal(tags.find((tag) => tag.name === '重点')?.id, 'tag-remote-1');
    assert.notEqual(tags.find((tag) => tag.name === '旧名'), undefined);
    // 孤儿 note-tag 被跳过（ghost-note 不存在）
    assert.equal(context.database.getNoteTag('ghost-note', 'tag-remote-1'), null);
    // 书名按远端文档更新
    assert.equal(context.database.getBook(book.id)?.title, '本地书（远端改名）');
  } finally {
    context.cleanup();
  }
});

test('附件导入强校验：哈希不符拒绝，匹配则落盘', () => {
  const context = makeContext();
  try {
    const book = context.database.createBook('附件同步');
    const note = context.database.saveNote({
      noteId: null,
      bookId: book.id,
      quote: '正文',
      comment: null,
      pageStart: null,
      pageEnd: null,
      tagIds: [],
    });
    const assetDir = join(context.workspace, 'assets');
    mkdirSync(assetDir, { recursive: true });
    const bytes = Buffer.from([137, 80, 78, 71, 42, 42]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    // 同步仓库中的资产文件以内容哈希命名（与 storedFileName 一致）
    writeFileSync(join(assetDir, `${hash}.png`), bytes);

    const base = {
      id: 'att-remote-1',
      noteId: note.id,
      storedFileName: `${hash}.png`,
      originalFileName: 'remote.png',
      mimeType: 'image/png',
      byteSize: bytes.length,
      width: null,
      height: null,
      sortOrder: 0,
      contentHash: hash,
      createdAt: 1,
      updatedAt: 1,
      sourcePath: join(assetDir, `${hash}.png`),
    };
    // 本测试自己的 createBook/saveNote 已写入 outbox，记录基线（导入不得增加）。
    const pendingBefore = context.database.getPendingSyncChanges().length;
    // storedFileName 必须以 contentHash 开头：哈希不符 → 整批导入失败（源批次语义）
    assert.throws(
      () =>
        importDocuments(
          context.database,
          context.attachments,
          [
            decodeDocument(
              JSON.stringify({
                type: 'attachment',
                id: base.id,
                deleted: false,
                createdAt: 1,
                updatedAt: 1,
                updatedBy: DEVICE,
                noteId: base.noteId,
                storedFileName: base.storedFileName,
                originalFileName: base.originalFileName,
                mimeType: base.mimeType,
                byteSize: base.byteSize,
                width: null,
                height: null,
                sortOrder: 0,
                contentHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
              }),
            ),
          ],
          context.workspace,
        ),
      /附件资源文件名无效/,
    );
    assert.equal(context.database.getAttachmentsForNote(note.id).length, 0);
    importDocuments(
      context.database,
      context.attachments,
      [
        decodeDocument(
          JSON.stringify({
            type: 'attachment',
            id: base.id,
            deleted: false,
            createdAt: 1,
            updatedAt: 1,
            updatedBy: DEVICE,
            noteId: base.noteId,
            storedFileName: base.storedFileName,
            originalFileName: base.originalFileName,
            mimeType: base.mimeType,
            byteSize: base.byteSize,
            width: null,
            height: null,
            sortOrder: 0,
            contentHash: hash,
          }),
        ),
      ],
      context.workspace,
    );
    const attachments = context.database.getAttachmentsForNote(note.id);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].contentHash, hash);
    assert.ok(existsSync(join(context.temporary, 'media', `${hash}.png`)));
    // 导入不产生 outbox（不回环）：outbox 数量与导入前一致
    assert.equal(context.database.getPendingSyncChanges().length, pendingBefore);
  } finally {
    context.cleanup();
  }
});


test('M6 兼容：旧 card_note 同步仓库（含 links/ 与 ai_accepted 标签）导入', () => {
  const context = makeContext();
  try {
    // 手工构造一份旧格式工作区：card-note.json + books/notes/tags/note-tags/links/attachments
    const ws = context.workspace;
    mkdirSync(join(ws, 'books'), { recursive: true });
    mkdirSync(join(ws, 'notes'), { recursive: true });
    mkdirSync(join(ws, 'tags'), { recursive: true });
    mkdirSync(join(ws, 'note-tags'), { recursive: true });
    mkdirSync(join(ws, 'links'), { recursive: true });
    // 旧清单可能带 createdAt（D12）：多余字段必须被容忍
    writeFileSync(
      join(ws, 'card-note.json'),
      JSON.stringify({ format: 'card-note-sync', formatVersion: 1, createdAt: 1780000000000 }, null, 2),
      'utf-8',
    );
    const json = (relative, value) => writeFileSync(join(ws, relative), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    json('books/old-book.json', {
      type: 'book', id: 'old-book', deleted: false, createdAt: 100, updatedAt: 100, updatedBy: 'old-device', title: '旧应用的书',
    });
    json('notes/old-note.json', {
      type: 'note', id: 'old-note', deleted: false, createdAt: 100, updatedAt: 100, updatedBy: 'old-device',
      contentRevision: 4, bookId: 'old-book', quote: '旧数据正文', comment: null, pageStart: 3, pageEnd: null,
    });
    json('tags/old-tag.json', {
      type: 'tag', id: 'old-tag', deleted: false, createdAt: 100, updatedAt: 100, updatedBy: 'old-device',
      name: 'AI标签', normalizedName: 'ai标签',
    });
    json('note-tags/old-note--old-tag.json', {
      type: 'note-tag', id: 'old-note--old-tag', deleted: false, createdAt: 100, updatedAt: 100, updatedBy: 'old-device',
      noteId: 'old-note', tagId: 'old-tag', source: 'ai_accepted',
    });
    // links/ 目录：目标类型集合不含 link（R4）——必须被静默忽略（即使内容是"非法"文档）
    json('links/some-link.json', { type: 'link', id: 'some-link', deleted: false });

    const documents = readAndValidate(ws);
    assert.equal(documents.length, 4); // 不含 links/

    const result = importDocuments(context.database, context.attachments, documents, ws);
    assert.equal(result.documentCount, 4);
    const book = context.database.getBook('old-book');
    assert.equal(book?.title, '旧应用的书');
    const note = context.database.getNote('old-note');
    assert.equal(note?.contentRevision, 4);
    assert.equal(note?.pageStart, 3);
    // ai_accepted 标签照常迁入（值原样保留，仅作来源标记）
    const tags = context.database.getTagsForNote('old-note');
    assert.deepEqual(
      tags.map((tag) => `${tag.name}:${context.database.getNoteTag('old-note', tag.id)?.source}`),
      ['AI标签:ai_accepted'],
    );
    // UUID 保留 → 重复导入幂等
    importDocuments(context.database, context.attachments, documents, ws);
    assert.equal(context.database.listBooks().length, 1);
    assert.equal(context.database.listNotes('old-book').length, 1);
  } finally {
    context.cleanup();
  }
});

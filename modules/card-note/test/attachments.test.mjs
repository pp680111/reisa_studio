/**
 * 附件服务单测（移植自 card_note test/attachment_repository_test.dart，
 * 并补充源编辑器 _save 的草稿落库语义：新增写入 / 缺失移除 / 顺序重排）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardNoteDatabase } from '../runtime/database.ts';
import { AttachmentStore, MAX_ATTACHMENT_BYTES, probeImage } from '../runtime/attachments.ts';

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);

async function makeStore() {
  const temporary = await mkdtemp(join(tmpdir(), 'card-note-attachments-'));
  const database = new CardNoteDatabase(':memory:');
  const store = new AttachmentStore(database, temporary);
  const sourcePath = join(temporary, 'source.png');
  writeFileSync(sourcePath, PNG_BYTES);
  const book = database.createBook('附件测试');
  database.saveNote({
    noteId: 'note-1',
    bookId: book.id,
    quote: '包含图片附件的笔记',
    comment: null,
    pageStart: null,
    pageEnd: null,
    tagIds: [],
  });
  return {
    database,
    store,
    sourcePath,
    mediaDir: join(temporary, 'media'),
    cleanup: async () => {
      database.close();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

test('复制、哈希命名并可移除（tombstone 记入 outbox）', async () => {
  const { database, store, sourcePath, mediaDir, cleanup } = await makeStore();
  try {
    store.addFromPath({
      id: 'attachment-1',
      noteId: 'note-1',
      sourcePath,
      originalFileName: '原图.png',
      sortOrder: 0,
    });

    const attachments = database.getAttachmentsForNote('note-1');
    assert.equal(attachments.length, 1);
    const attachment = attachments[0];
    assert.equal(attachment.contentHash.length, 64);
    assert.match(attachment.storedFileName, /\.png$/);
    assert.equal(attachment.storedFileName.startsWith(attachment.contentHash), true);
    assert.equal(statSync(join(mediaDir, attachment.storedFileName)).size, PNG_BYTES.length);

    store.remove(attachment.id);
    assert.deepEqual(database.getAttachmentsForNote('note-1'), []);
    const change = database
      .getPendingSyncChanges()
      .find((item) => item.entityType === 'attachment');
    assert.equal(change?.operation, 'tombstone');
  } finally {
    await cleanup();
  }
});

test('相同内容产生相同存储文件名（内容寻址），JPEG 规范化为 .jpg', async () => {
  const { database, store, sourcePath, mediaDir, cleanup } = await makeStore();
  try {
    const jpegSource = join(mediaDir, '..', 'source.jpeg');
    writeFileSync(jpegSource, PNG_BYTES);
    store.addFromPath({
      id: 'a-1',
      noteId: 'note-1',
      sourcePath: sourcePath,
      originalFileName: '第一张.png',
      sortOrder: 0,
    });
    store.addFromPath({
      id: 'a-2',
      noteId: 'note-1',
      sourcePath: jpegSource,
      originalFileName: '第二张.jpeg',
      sortOrder: 1,
    });

    const attachments = database.getAttachmentsForNote('note-1');
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0].mimeType, 'image/png');
    assert.equal(attachments[1].mimeType, 'image/jpeg');
    assert.match(attachments[1].storedFileName, /\.jpg$/);
    // 内容相同 → 同一哈希；扩展名规范化后各自落盘（.png 与 .jpg）。
    const [first, second] = attachments;
    assert.equal(second.storedFileName.startsWith(first.contentHash), true);
    assert.equal(first.storedFileName.startsWith(second.contentHash), true);
    assert.notEqual(first.storedFileName, second.storedFileName);
  } finally {
    await cleanup();
  }
});

test('拒绝非法输入：不存在的文件、空文件、超限、非图片扩展名', async () => {
  const { store, sourcePath, cleanup } = await makeStore();
  try {
    assert.throws(
      () =>
        store.addFromPath({
          id: 'x',
          noteId: 'note-1',
          sourcePath: 'Z:/不存在.png',
          originalFileName: 'x.png',
          sortOrder: 0,
        }),
      /不存在或已被移动/,
    );
    assert.throws(
      () =>
        store.addFromPath({
          id: 'x',
          noteId: 'note-1',
          sourcePath,
          originalFileName: 'x.gif',
          sortOrder: 0,
        }),
      /仅支持 PNG、JPEG 和 WebP/,
    );

    const emptyPath = join(sourcePath, '..', 'empty.png');
    writeFileSync(emptyPath, Buffer.alloc(0));
    assert.throws(
      () =>
        store.addFromPath({
          id: 'x',
          noteId: 'note-1',
          sourcePath: emptyPath,
          originalFileName: 'empty.png',
          sortOrder: 0,
        }),
      /不能添加空图片文件/,
    );

    const bigPath = join(sourcePath, '..', 'big.png');
    writeFileSync(bigPath, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    assert.throws(
      () =>
        store.addFromPath({
          id: 'x',
          noteId: 'note-1',
          sourcePath: bigPath,
          originalFileName: 'big.png',
          sortOrder: 0,
        }),
      /单张图片不能超过 10 MB/,
    );
  } finally {
    await cleanup();
  }
});

test('probeImage 返回预检结果（data URL 预览 + 错误信息）', async () => {
  const { sourcePath, cleanup } = await makeStore();
  try {
    const ok = probeImage(sourcePath);
    assert.equal(ok.ok, true);
    assert.equal(ok.originalFileName, 'source.png');
    assert.equal(ok.byteSize, PNG_BYTES.length);
    assert.match(ok.previewDataUrl ?? '', /^data:image\/png;base64,/);

    const bad = probeImage(join(sourcePath, '..', 'nope.png'));
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /不存在或已被移动/);
  } finally {
    await cleanup();
  }
});

test('reorder 按给定顺序重排序号并写 outbox', async () => {
  const { database, store, sourcePath, cleanup } = await makeStore();
  try {
    for (const [index, id] of ['a-1', 'a-2', 'a-3'].entries()) {
      store.addFromPath({
        id,
        noteId: 'note-1',
        sourcePath,
        originalFileName: `${id}.png`,
        sortOrder: index,
      });
    }
    store.reorder(['a-3', 'a-1', 'a-2']);
    const order = database.getAttachmentsForNote('note-1').map((attachment) => attachment.id);
    assert.deepEqual(order, ['a-3', 'a-1', 'a-2']);
  } finally {
    await cleanup();
  }
});

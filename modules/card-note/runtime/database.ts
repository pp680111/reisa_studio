import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 卡片笔记数据库（迁移自 card_note `lib/core/database/app_database.dart`——业务规则真源）。
 *
 * schema v1 = 源 schema v3 精简（迁移设计文档附录 A）：
 * - 移除 `ai_tag_suggestions` / `ai_jobs`（决策 R1/R2）、`note_links`（R4）；
 * - 移除 `app_settings`（v0.6：模块配置改存 `settings.json`，经 ModuleConfigScope）；
 * - 其余表结构与约束逐字段等价，UUID 主键 + UTC 毫秒时间戳与源一致，
 *   支撑 M6 经旧 Git 同步仓库直接导入。
 *
 * 与源项目相同，全部业务事务（级联删除、标签重建、同步 outbox 记录）都集中在这一层；
 * 迁移设计文档第 5 节的行为清单即本文件的验收标准，对应单测见 test/database.test.mjs。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  quote TEXT NOT NULL,
  comment TEXT,
  page_start INTEGER,
  page_end INTEGER,
  content_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note_attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  stored_file_name TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag_id)
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
`;

/** 领域规则错误（消息与源项目逐一对应，UI 直接展示）。 */
export class DomainError extends Error {}

export interface Book {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Note {
  readonly id: string;
  readonly bookId: string;
  readonly quote: string;
  readonly comment: string | null;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly contentRevision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Attachment {
  readonly id: string;
  readonly noteId: string;
  readonly storedFileName: string;
  readonly originalFileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sortOrder: number;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OutboxChange {
  readonly entityType: string;
  readonly entityId: string;
  readonly operation: string;
  readonly changedAt: number;
}

export interface SaveNoteInput {
  /** null 表示新建。 */
  readonly noteId: string | null;
  readonly bookId: string;
  readonly quote: string;
  readonly comment: string | null;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly tagIds?: readonly string[];
}

export function normalizeTagName(value: string): string {
  return value.trim().toLowerCase();
}

/** note-tag 同步身份：与源项目及同步仓库格式一致（`<noteId>--<tagId>`）。 */
export function noteTagSyncId(noteId: string, tagId: string): string {
  return `${noteId}--${tagId}`;
}

interface BookRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface NoteRow {
  id: string;
  book_id: string;
  quote: string;
  comment: string | null;
  page_start: number | null;
  page_end: number | null;
  content_revision: number;
  created_at: number;
  updated_at: number;
}

interface TagRow {
  id: string;
  name: string;
  normalized_name: string;
  created_at: number;
  updated_at: number;
}

interface AttachmentRow {
  id: string;
  note_id: string;
  stored_file_name: string;
  original_file_name: string;
  mime_type: string;
  byte_size: number;
  sort_order: number;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

function toBook(row: BookRow): Book {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    bookId: row.book_id,
    quote: row.quote,
    comment: row.comment,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    contentRevision: row.content_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    noteId: row.note_id,
    storedFileName: row.stored_file_name,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sortOrder: row.sort_order,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CardNoteDatabase {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #filePath: string;
  #inTransaction = false;

  constructor(filePath: string, options: { now?: () => number } = {}) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.#db = new DatabaseSync(filePath);
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
    this.#now = options.now ?? Date.now;
    this.#filePath = filePath;
  }

  close(): void {
    this.#db.close();
  }

  /** node:sqlite 无内建事务 API；嵌套调用并入外层事务（与 drift transaction 语义一致）。 */
  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      this.#inTransaction = false;
      return result;
    } catch (error) {
      this.#inTransaction = false;
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // 回滚失败时以外层异常为准。
      }
      throw error;
    }
  }

  // ---- 同步 outbox（M5 Git 同步的数据源；与业务写入同事务记录） ----

  #recordSyncChange(
    entityType: string,
    entityId: string,
    operation: string,
    changedAt: number,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO sync_outbox (entity_type, entity_id, operation, changed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id)
         DO UPDATE SET operation = excluded.operation, changed_at = excluded.changed_at`,
      )
      .run(entityType, entityId, operation, changedAt);
  }

  getPendingSyncChanges(): OutboxChange[] {
    const rows = this.#db
      .prepare(
        `SELECT entity_type, entity_id, operation, changed_at
         FROM sync_outbox
         ORDER BY changed_at ASC, entity_type ASC, entity_id ASC`,
      )
      .all() as unknown as Array<{
      entity_type: string;
      entity_id: string;
      operation: string;
      changed_at: number;
    }>;
    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      changedAt: row.changed_at,
    }));
  }

  acknowledgeSyncChanges(changes: readonly OutboxChange[]): void {
    this.transaction(() => {
      for (const change of changes) {
        this.#db
          .prepare(
            `DELETE FROM sync_outbox
             WHERE entity_type = ? AND entity_id = ? AND changed_at = ?`,
          )
          .run(change.entityType, change.entityId, change.changedAt);
      }
    });
  }

  // ---- 书籍（源 watchBooks/createBook/renameBook/deleteBook） ----

  listBooks(): Book[] {
    return (
      this.#db.prepare('SELECT * FROM books ORDER BY updated_at DESC').all() as unknown as BookRow[]
    ).map(toBook);
  }

  getBook(bookId: string): Book | null {
    const row = this.#db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as
      BookRow | undefined;
    return row ? toBook(row) : null;
  }

  createBook(rawTitle: string): Book {
    const title = rawTitle.trim();
    if (title === '') {
      throw new DomainError('书名不能为空');
    }
    const now = this.#now();
    const id = randomUUID();
    return this.transaction(() => {
      this.#db
        .prepare('INSERT INTO books (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, title, now, now);
      this.#recordSyncChange('book', id, 'upsert', now);
      return { id, title, createdAt: now, updatedAt: now };
    });
  }

  renameBook(bookId: string, rawTitle: string): Book {
    const title = rawTitle.trim();
    if (title === '') {
      throw new DomainError('书名不能为空');
    }
    const now = this.#now();
    return this.transaction(() => {
      const updated = this.#db
        .prepare('UPDATE books SET title = ?, updated_at = ? WHERE id = ?')
        .run(title, now, bookId);
      if (updated.changes === 0) {
        throw new DomainError('书籍不存在或已被删除');
      }
      this.#recordSyncChange('book', bookId, 'upsert', now);
      return this.#requireBook(bookId);
    });
  }

  /**
   * 删除书籍：先写全部 tombstone outbox，再删行（外键级联清 notes/note_tags/attachments）。
   * 源实现同序（app_database.dart deleteBook）；AI 任务清理随 R2 移除。
   */
  deleteBook(bookId: string): void {
    this.transaction(() => {
      const bookNotes = this.#db
        .prepare('SELECT id FROM notes WHERE book_id = ?')
        .all(bookId) as unknown as { id: string }[];
      const noteIds = bookNotes.map((note) => note.id);
      const associations =
        noteIds.length === 0
          ? []
          : (this.#db
              .prepare(
                `SELECT note_id, tag_id FROM note_tags
                 WHERE note_id IN (${noteIds.map(() => '?').join(', ')})`,
              )
              .all(...noteIds) as unknown as { note_id: string; tag_id: string }[]);
      const attachments =
        noteIds.length === 0
          ? []
          : (this.#db
              .prepare(
                `SELECT id FROM note_attachments
                 WHERE note_id IN (${noteIds.map(() => '?').join(', ')})`,
              )
              .all(...noteIds) as unknown as { id: string }[]);
      const now = this.#now();
      this.#recordSyncChange('book', bookId, 'tombstone', now);
      for (const note of bookNotes) {
        this.#recordSyncChange('note', note.id, 'tombstone', now);
      }
      for (const association of associations) {
        this.#recordSyncChange(
          'note-tag',
          noteTagSyncId(association.note_id, association.tag_id),
          'tombstone',
          now,
        );
      }
      for (const attachment of attachments) {
        this.#recordSyncChange('attachment', attachment.id, 'tombstone', now);
      }
      this.#db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
    });
  }

  #requireBook(bookId: string): Book {
    const book = this.getBook(bookId);
    if (book === null) {
      throw new DomainError('书籍不存在或已被删除');
    }
    return book;
  }

  // ---- 标签（源 watchTags/ensureTag/renameTag/deleteTag；归一化名全局唯一） ----

  listTags(): Tag[] {
    return (
      this.#db
        .prepare('SELECT * FROM tags ORDER BY normalized_name ASC')
        .all() as unknown as TagRow[]
    ).map(toTag);
  }

  ensureTag(rawName: string): Tag {
    const name = rawName.trim();
    const normalizedName = normalizeTagName(name);
    if (normalizedName === '') {
      throw new DomainError('标签名不能为空');
    }
    const now = this.#now();
    return this.transaction(() => {
      const existing = this.#db
        .prepare('SELECT * FROM tags WHERE normalized_name = ?')
        .get(normalizedName) as TagRow | undefined;
      if (existing) {
        return toTag(existing);
      }
      const id = randomUUID();
      this.#db
        .prepare(
          'INSERT INTO tags (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, name, normalizedName, now, now);
      this.#recordSyncChange('tag', id, 'upsert', now);
      return { id, name, normalizedName, createdAt: now, updatedAt: now };
    });
  }

  renameTag(tagId: string, rawName: string): Tag {
    const name = rawName.trim();
    const normalizedName = normalizeTagName(name);
    if (normalizedName === '') {
      throw new DomainError('标签名不能为空');
    }
    const now = this.#now();
    return this.transaction(() => {
      const conflict = this.#db
        .prepare('SELECT * FROM tags WHERE normalized_name = ? AND id <> ?')
        .get(normalizedName, tagId) as TagRow | undefined;
      if (conflict) {
        throw new DomainError(`已有同名标签：${conflict.name}`);
      }
      const updated = this.#db
        .prepare('UPDATE tags SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?')
        .run(name, normalizedName, now, tagId);
      if (updated.changes === 0) {
        throw new DomainError('标签不存在或已被删除');
      }
      this.#recordSyncChange('tag', tagId, 'upsert', now);
      const row = this.#db
        .prepare('SELECT * FROM tags WHERE id = ?')
        .get(tagId) as unknown as TagRow;
      return toTag(row);
    });
  }

  /** 删除标签：级联清 note_tags（不删笔记）；写 tag 与 note-tag 两类 tombstone。 */
  deleteTag(tagId: string): void {
    this.transaction(() => {
      const associations = this.#db
        .prepare('SELECT note_id, tag_id FROM note_tags WHERE tag_id = ?')
        .all(tagId) as unknown as { note_id: string; tag_id: string }[];
      const now = this.#now();
      this.#recordSyncChange('tag', tagId, 'tombstone', now);
      for (const association of associations) {
        this.#recordSyncChange(
          'note-tag',
          noteTagSyncId(association.note_id, association.tag_id),
          'tombstone',
          now,
        );
      }
      this.#db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
    });
  }

  // ---- 笔记（源 watchNotes/getNote/saveNote/deleteNote；按 createdAt DESC, id ASC 排序） ----

  listNotes(bookId: string, query = ''): Note[] {
    const normalizedQuery = query.trim();
    if (normalizedQuery === '') {
      return (
        this.#db
          .prepare('SELECT * FROM notes WHERE book_id = ? ORDER BY created_at DESC, id ASC')
          .all(bookId) as unknown as NoteRow[]
      ).map(toNote);
    }
    const pattern = `%${normalizedQuery}%`;
    return (
      this.#db
        .prepare(
          `SELECT * FROM notes
           WHERE book_id = ? AND (quote LIKE ? OR comment LIKE ?)
           ORDER BY created_at DESC, id ASC`,
        )
        .all(bookId, pattern, pattern) as unknown as NoteRow[]
    ).map(toNote);
  }

  getNote(noteId: string): Note | null {
    const row = this.#db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as
      NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  /**
   * 保存笔记（源 saveNote 事务，迁移设计文档 §5.2）：
   * 1. 插入或更新，contentRevision = 旧值 + 1（每次保存都递增，即使内容未变）；
   * 2. 全删重插 note_tags（source='manual'），tagIds 必须全部存在；
   * 3. outbox：note upsert + note-tag upsert（新集合）/ tombstone（被移除项）。
   * 源步骤 4/5（AI tag_note/link_book 任务排队）随 R2 移除。
   */
  saveNote(input: SaveNoteInput): Note {
    const now = this.#now();
    return this.transaction(() => {
      const existing = input.noteId === null ? null : this.getNote(input.noteId);
      // 与源一致：新笔记使用调用方传入的 noteId（编辑器预生成 UUID，
      // 附件草稿在首次保存前即可引用该 ID），仅未传时才生成。
      const id = input.noteId ?? randomUUID();
      const revision = (existing?.contentRevision ?? 0) + 1;
      if (existing === null) {
        this.#db
          .prepare(
            `INSERT INTO notes
             (id, book_id, quote, comment, page_start, page_end, content_revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.bookId,
            input.quote,
            input.comment,
            input.pageStart,
            input.pageEnd,
            revision,
            now,
            now,
          );
      } else {
        this.#db
          .prepare(
            `UPDATE notes
             SET quote = ?, comment = ?, page_start = ?, page_end = ?, content_revision = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.quote, input.comment, input.pageStart, input.pageEnd, revision, now, id);
      }

      const uniqueTagIds = [...new Set(input.tagIds ?? [])];
      const oldAssociations = this.#db
        .prepare('SELECT tag_id FROM note_tags WHERE note_id = ?')
        .all(id) as unknown as { tag_id: string }[];
      if (uniqueTagIds.length > 0) {
        const placeholders = uniqueTagIds.map(() => '?').join(', ');
        const existingTags = this.#db
          .prepare(`SELECT COUNT(*) AS count FROM tags WHERE id IN (${placeholders})`)
          .get(...uniqueTagIds) as { count: number };
        if (existingTags.count !== uniqueTagIds.length) {
          throw new DomainError('存在无效的标签');
        }
      }
      this.#db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id);
      for (const tagId of uniqueTagIds) {
        this.#db
          .prepare(
            'INSERT INTO note_tags (note_id, tag_id, source, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(id, tagId, 'manual', now);
      }

      this.#recordSyncChange('note', id, 'upsert', now);
      const oldTagIds = new Set(oldAssociations.map((item) => item.tag_id));
      for (const tagId of oldTagIds) {
        if (!uniqueTagIds.includes(tagId)) {
          this.#recordSyncChange('note-tag', noteTagSyncId(id, tagId), 'tombstone', now);
        }
      }
      for (const tagId of uniqueTagIds) {
        this.#recordSyncChange('note-tag', noteTagSyncId(id, tagId), 'upsert', now);
      }

      return this.#requireNote(id);
    });
  }

  /** 删除笔记：tombstone（note/note-tag/attachment）→ 删行级联（源 deleteNote，链接部分随 R4 移除）。 */
  deleteNote(noteId: string): void {
    this.transaction(() => {
      const associations = this.#db
        .prepare('SELECT note_id, tag_id FROM note_tags WHERE note_id = ?')
        .all(noteId) as unknown as { note_id: string; tag_id: string }[];
      const attachments = this.#db
        .prepare('SELECT id FROM note_attachments WHERE note_id = ?')
        .all(noteId) as unknown as { id: string }[];
      const now = this.#now();
      this.#recordSyncChange('note', noteId, 'tombstone', now);
      for (const association of associations) {
        this.#recordSyncChange(
          'note-tag',
          noteTagSyncId(association.note_id, association.tag_id),
          'tombstone',
          now,
        );
      }
      for (const attachment of attachments) {
        this.#recordSyncChange('attachment', attachment.id, 'tombstone', now);
      }
      this.#db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
    });
  }

  #requireNote(noteId: string): Note {
    const note = this.getNote(noteId);
    if (note === null) {
      throw new DomainError('笔记不存在或已被删除');
    }
    return note;
  }

  // ---- 笔记 ↔ 标签关联（源 watchTagsForNote/getTagIdsForNote） ----

  getTagsForNote(noteId: string): Tag[] {
    return (
      this.#db
        .prepare(
          `SELECT tags.* FROM tags
           INNER JOIN note_tags ON note_tags.tag_id = tags.id
           WHERE note_tags.note_id = ?
           ORDER BY tags.normalized_name ASC`,
        )
        .all(noteId) as unknown as TagRow[]
    ).map(toTag);
  }

  getTagIdsForNote(noteId: string): Set<string> {
    const rows = this.#db
      .prepare('SELECT tag_id FROM note_tags WHERE note_id = ?')
      .all(noteId) as unknown as { tag_id: string }[];
    return new Set(rows.map((row) => row.tag_id));
  }

  // ---- 附件（行级操作；文件级校验/存储在 runtime/attachments.ts，对应源 AttachmentRepository） ----

  getAttachmentsForNote(noteId: string): Attachment[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM note_attachments WHERE note_id = ?
           ORDER BY sort_order ASC, created_at ASC`,
        )
        .all(noteId) as unknown as AttachmentRow[]
    ).map(toAttachment);
  }

  getAttachment(attachmentId: string): Attachment | null {
    const row = this.#db
      .prepare('SELECT * FROM note_attachments WHERE id = ?')
      .get(attachmentId) as AttachmentRow | undefined;
    return row ? toAttachment(row) : null;
  }

  /** upsert + outbox（源 AppDatabase.upsertAttachment）。 */
  upsertAttachment(attachment: {
    id: string;
    noteId: string;
    storedFileName: string;
    originalFileName: string;
    mimeType: string;
    byteSize: number;
    sortOrder: number;
    contentHash: string;
  }): void {
    this.transaction(() => {
      const now = this.#now();
      this.#db
        .prepare(
          `INSERT INTO note_attachments
           (id, note_id, stored_file_name, original_file_name, mime_type, byte_size, sort_order, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             note_id = excluded.note_id,
             stored_file_name = excluded.stored_file_name,
             original_file_name = excluded.original_file_name,
             mime_type = excluded.mime_type,
             byte_size = excluded.byte_size,
             sort_order = excluded.sort_order,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at`,
        )
        .run(
          attachment.id,
          attachment.noteId,
          attachment.storedFileName,
          attachment.originalFileName,
          attachment.mimeType,
          attachment.byteSize,
          attachment.sortOrder,
          attachment.contentHash,
          now,
          now,
        );
      this.#recordSyncChange('attachment', attachment.id, 'upsert', now);
    });
  }

  /** tombstone + 删除（源 AppDatabase.deleteAttachment；内容寻址文件不随之删除）。 */
  deleteAttachment(attachmentId: string): void {
    this.transaction(() => {
      const existing = this.getAttachment(attachmentId);
      if (existing === null) return;
      const now = this.#now();
      this.#recordSyncChange('attachment', attachmentId, 'tombstone', now);
      this.#db.prepare('DELETE FROM note_attachments WHERE id = ?').run(attachmentId);
    });
  }

  /** 单事务重排序号 + outbox（源 AppDatabase.reorderAttachments）。 */
  reorderAttachments(attachmentIds: readonly string[]): void {
    this.transaction(() => {
      const now = this.#now();
      for (let index = 0; index < attachmentIds.length; index++) {
        const id = attachmentIds[index] ?? '';
        this.#db
          .prepare('UPDATE note_attachments SET sort_order = ?, updated_at = ? WHERE id = ?')
          .run(index, now, id);
        this.#recordSyncChange('attachment', id, 'upsert', now);
      }
    });
  }

  // ---- 同步导入/导出专用行级访问（仅 sync 子系统使用） ----
  // 这些方法不产生 outbox、不走领域校验：导入路径的数据已在 SyncDocument 校验过。

  getAllBooks(): Book[] {
    return (this.#db.prepare('SELECT * FROM books').all() as unknown as BookRow[]).map(toBook);
  }

  getAllNotes(): Note[] {
    return (this.#db.prepare('SELECT * FROM notes').all() as unknown as NoteRow[]).map(toNote);
  }

  getAllNoteTags(): Array<{ noteId: string; tagId: string; source: string; createdAt: number }> {
    return (
      this.#db.prepare('SELECT * FROM note_tags').all() as unknown as Array<{
        note_id: string;
        tag_id: string;
        source: string;
        created_at: number;
      }>
    ).map((row) => ({
      noteId: row.note_id,
      tagId: row.tag_id,
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  getNoteTag(
    noteId: string,
    tagId: string,
  ): { noteId: string; tagId: string; source: string; createdAt: number } | null {
    const row = this.#db
      .prepare('SELECT * FROM note_tags WHERE note_id = ? AND tag_id = ?')
      .get(noteId, tagId) as
      { note_id: string; tag_id: string; source: string; created_at: number } | undefined;
    return row
      ? { noteId: row.note_id, tagId: row.tag_id, source: row.source, createdAt: row.created_at }
      : null;
  }

  /** INSERT OR REPLACE：以同步文档为准覆盖整行（不触碰 created_at 语义之外的字段）。 */
  upsertBookRow(input: { id: string; title: string; createdAt: number; updatedAt: number }): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO books (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.id, input.title, input.createdAt, input.updatedAt);
  }

  upsertNoteRow(input: {
    id: string;
    bookId: string;
    quote: string;
    comment: string | null;
    pageStart: number | null;
    pageEnd: number | null;
    contentRevision: number;
    createdAt: number;
    updatedAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO notes
         (id, book_id, quote, comment, page_start, page_end, content_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.bookId,
        input.quote,
        input.comment,
        input.pageStart,
        input.pageEnd,
        input.contentRevision,
        input.createdAt,
        input.updatedAt,
      );
  }

  upsertTagRow(input: {
    id: string;
    name: string;
    normalizedName: string;
    createdAt: number;
    updatedAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO tags (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.name, input.normalizedName, input.createdAt, input.updatedAt);
  }

  upsertNoteTagRow(input: {
    noteId: string;
    tagId: string;
    source: string;
    createdAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO note_tags (note_id, tag_id, source, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.noteId, input.tagId, input.source, input.createdAt);
  }

  deleteNoteTagRow(noteId: string, tagId: string): void {
    this.#db.prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?').run(noteId, tagId);
  }

  deleteAttachmentRow(attachmentId: string): void {
    this.#db.prepare('DELETE FROM note_attachments WHERE id = ?').run(attachmentId);
  }

  getAllAttachments(): Attachment[] {
    return (
      this.#db.prepare('SELECT * FROM note_attachments').all() as unknown as AttachmentRow[]
    ).map(toAttachment);
  }

  upsertAttachmentRow(input: {
    id: string;
    noteId: string;
    storedFileName: string;
    originalFileName: string;
    mimeType: string;
    byteSize: number;
    sortOrder: number;
    contentHash: string;
    createdAt: number;
    updatedAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO note_attachments
         (id, note_id, stored_file_name, original_file_name, mime_type, byte_size, sort_order, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.noteId,
        input.storedFileName,
        input.originalFileName,
        input.mimeType,
        input.byteSize,
        input.sortOrder,
        input.contentHash,
        input.createdAt,
        input.updatedAt,
      );
  }

  /** 数据库文件路径（M5 导入前备份用）。 */
  get filePath(): string {
    return this.#filePath;
  }

  /** 模块数据目录（media/ 的父目录）。 */
  get dataDir(): string {
    return dirname(this.#filePath);
  }

  getTagRow(tagId: string): Tag | null {
    const row = this.#db.prepare('SELECT * FROM tags WHERE id = ?').get(tagId) as
      TagRow | undefined;
    return row ? toTag(row) : null;
  }

  getNoteTagsForTag(
    tagId: string,
  ): Array<{ noteId: string; tagId: string; source: string; createdAt: number }> {
    return (
      this.#db.prepare('SELECT * FROM note_tags WHERE tag_id = ?').all(tagId) as unknown as Array<{
        note_id: string;
        tag_id: string;
        source: string;
        created_at: number;
      }>
    ).map((row) => ({
      noteId: row.note_id,
      tagId: row.tag_id,
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  deleteNoteTagsForTag(tagId: string): void {
    this.#db.prepare('DELETE FROM note_tags WHERE tag_id = ?').run(tagId);
  }

  /** 同步导入路径的直接行删除（不做 tombstone——文档本身就是删除事实）。 */
  deleteNoteRowDirect(noteId: string): void {
    this.#db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
  }

  deleteBookRowDirect(bookId: string): void {
    this.#db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  }

  deleteTagRowDirect(tagId: string): void {
    this.#db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
  }

  // ---- 统计（页面服务 get_stats） ----

  stats(): { books: number; notes: number; tags: number } {
    const count = (table: string): number =>
      (this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return { books: count('books'), notes: count('notes'), tags: count('tags') };
  }
}

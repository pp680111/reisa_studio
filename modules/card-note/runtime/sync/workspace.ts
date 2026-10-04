import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  decodeDocument,
  encodeDocument,
  encodeManifest,
  noteTagDocumentId,
  syncDirectoryFor,
  validateManifest,
  type SyncDocument,
  type SyncEntityTypeValue,
} from './document.ts';
import type { Attachment, CardNoteDatabase, Note, Tag } from '../database.ts';
import { createHash } from 'node:crypto';

/**
 * 同步工作区（迁移自 card_note `lib/features/sync/data/sync_workspace.dart`）。
 * 导出器只产文件不碰 Git；校验器在 rebase 后、导入前把关一切远端数据；
 * 导入器直接落行（不走编辑用例——不回环产生 outbox、不触发领域副作用）。
 * 实体集合不含 link（决策 R4）；旧仓库的 links/ 目录被静默忽略。
 */

const ENTITY_ORDER: readonly SyncEntityTypeValue[] = [
  'book',
  'note',
  'tag',
  'note-tag',
  'attachment',
];

// ---- 导出器 ----

export interface SyncExportResult {
  readonly documentCount: number;
  /** 仅增量导出时返回；调用方在 Git 提交与推送成功后确认。 */
  readonly changes?: Array<{
    entityType: string;
    entityId: string;
    operation: string;
    changedAt: number;
  }>;
}

function bookDocument(
  book: { id: string; title: string; createdAt: number; updatedAt: number },
  deviceId: string,
): SyncDocument {
  return {
    type: 'book',
    id: book.id,
    deleted: false,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    updatedBy: deviceId,
    fields: { title: book.title },
  };
}

function noteDocument(note: Note, deviceId: string): SyncDocument {
  return {
    type: 'note',
    id: note.id,
    deleted: false,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    updatedBy: deviceId,
    fields: {
      contentRevision: note.contentRevision,
      bookId: note.bookId,
      quote: note.quote,
      comment: note.comment,
      pageStart: note.pageStart,
      pageEnd: note.pageEnd,
    },
  };
}

function tagDocument(tag: Tag, deviceId: string): SyncDocument {
  return {
    type: 'tag',
    id: tag.id,
    deleted: false,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
    updatedBy: deviceId,
    fields: { name: tag.name, normalizedName: tag.normalizedName },
  };
}

function noteTagDocument(
  relation: { noteId: string; tagId: string; source: string; createdAt: number },
  deviceId: string,
): SyncDocument {
  return {
    type: 'note-tag',
    id: noteTagDocumentId(relation.noteId, relation.tagId),
    deleted: false,
    createdAt: relation.createdAt,
    updatedAt: relation.createdAt,
    updatedBy: deviceId,
    fields: { noteId: relation.noteId, tagId: relation.tagId, source: relation.source },
  };
}

function attachmentDocument(attachment: Attachment, deviceId: string): SyncDocument {
  return {
    type: 'attachment',
    id: attachment.id,
    deleted: false,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
    updatedBy: deviceId,
    fields: {
      noteId: attachment.noteId,
      storedFileName: attachment.storedFileName,
      originalFileName: attachment.originalFileName,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      width: null,
      height: null,
      sortOrder: attachment.sortOrder,
      contentHash: attachment.contentHash,
    },
  };
}

function tombstoneDocument(
  change: { entityType: string; entityId: string; changedAt: number },
  deviceId: string,
): SyncDocument {
  return {
    type: change.entityType as SyncEntityTypeValue,
    id: change.entityId,
    deleted: true,
    createdAt: change.changedAt,
    updatedAt: change.changedAt,
    updatedBy: deviceId,
    fields: {},
  };
}

function ensureWorkspace(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  const manifest = join(workspacePath, 'card-note.json');
  if (existsSync(manifest)) {
    validateManifest(readFileSync(manifest, 'utf-8'));
  } else {
    writeFileSync(manifest, encodeManifest(), 'utf-8');
  }
}

function writeDocument(workspacePath: string, document: SyncDocument): void {
  const directory = join(workspacePath, syncDirectoryFor(document.type));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${document.id}.json`), encodeDocument(document), 'utf-8');
}

function copyAsset(database: CardNoteDatabase, workspacePath: string, attachmentId: string): void {
  const attachment = database.getAttachment(attachmentId);
  if (attachment === null) {
    throw new Error('附件文件缺失：未知附件');
  }
  const assetDirectory = join(workspacePath, 'assets');
  mkdirSync(assetDirectory, { recursive: true });
  const destination = join(assetDirectory, attachment.storedFileName);
  if (!existsSync(destination)) {
    const source = join(join(database.dataDir, 'media'), attachment.storedFileName);
    if (!existsSync(source)) {
      throw new Error(`附件文件缺失：${attachment.originalFileName}`);
    }
    copyFileSync(source, destination);
  }
}

/** 全量快照（初始化新仓库时播种；实体按 (type, id) 排序保证确定性）。 */
export function exportSnapshot(
  database: CardNoteDatabase,
  workspacePath: string,
  deviceId: string,
): SyncExportResult {
  ensureWorkspace(workspacePath);
  const documents: SyncDocument[] = [
    ...database.getAllBooks().map((book) => bookDocument(book, deviceId)),
    ...database.getAllNotes().map((note) => noteDocument(note, deviceId)),
    ...database.listTags().map((tag) => tagDocument(tag, deviceId)),
    ...database.getAllNoteTags().map((relation) => noteTagDocument(relation, deviceId)),
    ...database.getAllAttachments().map((attachment) => attachmentDocument(attachment, deviceId)),
  ].sort((left, right) => {
    const byType = left.type.localeCompare(right.type);
    return byType !== 0 ? byType : left.id.localeCompare(right.id);
  });
  for (const document of documents) {
    writeDocument(workspacePath, document);
    if (document.type === 'attachment' && !document.deleted) {
      copyAsset(database, workspacePath, document.id);
    }
  }
  return { documentCount: documents.length };
}

/** 增量导出 outbox；调用方必须在 Git 提交与推送成功后确认（acknowledge）。 */
export function exportPendingChanges(
  database: CardNoteDatabase,
  workspacePath: string,
  deviceId: string,
): SyncExportResult {
  ensureWorkspace(workspacePath);
  const changes = database.getPendingSyncChanges();
  for (const change of changes) {
    const type = change.entityType as SyncEntityTypeValue;
    let document: SyncDocument | null = null;
    if (change.operation !== 'tombstone') {
      document = loadDocumentFor(database, type, change.entityId, deviceId);
    }
    const final = document ?? tombstoneDocument(change, deviceId);
    writeDocument(workspacePath, final);
    if (!final.deleted && final.type === 'attachment') {
      copyAsset(database, workspacePath, final.id);
    }
  }
  return {
    documentCount: changes.length,
    changes: changes.map((change) => ({ ...change })),
  };
}

function loadDocumentFor(
  database: CardNoteDatabase,
  type: SyncEntityTypeValue,
  entityId: string,
  deviceId: string,
): SyncDocument | null {
  switch (type) {
    case 'book': {
      const book = database.getBook(entityId);
      return book === null ? null : bookDocument(book, deviceId);
    }
    case 'note': {
      const note = database.getNote(entityId);
      return note === null ? null : noteDocument(note, deviceId);
    }
    case 'tag': {
      const tag = database.listTags().find((item) => item.id === entityId);
      return tag === undefined ? null : tagDocument(tag, deviceId);
    }
    case 'note-tag': {
      const separator = entityId.indexOf('--');
      if (separator <= 0 || separator === entityId.length - 2) return null;
      const noteId = entityId.slice(0, separator);
      const tagId = entityId.slice(separator + 2);
      const relation = database.getNoteTag(noteId, tagId);
      return relation === null ? null : noteTagDocument(relation, deviceId);
    }
    case 'attachment': {
      const attachment = database.getAttachment(entityId);
      return attachment === null ? null : attachmentDocument(attachment, deviceId);
    }
  }
}

// ---- 校验器 ----

/** 只读扫描并逐文档校验；文件名必须与文档身份一致。 */
export function readAndValidate(workspacePath: string): SyncDocument[] {
  const manifest = join(workspacePath, 'card-note.json');
  if (!existsSync(manifest)) {
    throw new Error('未找到 Card Note 同步仓库清单');
  }
  validateManifest(readFileSync(manifest, 'utf-8'));
  const documents: SyncDocument[] = [];
  for (const type of ENTITY_ORDER) {
    const directory = join(workspacePath, syncDirectoryFor(type));
    if (!existsSync(directory)) continue;
    for (const entry of readdirSafe(directory)) {
      if (!entry.endsWith('.json')) continue;
      const document = decodeDocument(readFileSync(join(directory, entry), 'utf-8'));
      if (document.type !== type || entry !== `${document.id}.json`) {
        throw new Error(`同步文件路径与文档身份不一致：${entry}`);
      }
      documents.push(document);
    }
  }
  return documents;
}

function readdirSafe(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

// ---- 导入器 ----

export interface SyncImportResult {
  readonly documentCount: number;
}

/**
 * 应用已校验的文档（源 SyncWorkspaceImporter）：
 * 单事务；先 tombstone 后 upsert；同名标签合并（归一化名分组，updatedAt 最新为 winner）；
 * 孤儿关联静默跳过；附件做哈希/大小强校验后复制入 media/。
 * 不产生 outbox（不回环）、不触发 AI/领域副作用。
 */
export function importDocuments(
  database: CardNoteDatabase,
  attachments: { importSynced(input: ImportSyncedInput & { sourcePath: string }): void },
  incoming: SyncDocument[],
  workspacePath: string | null,
): SyncImportResult {
  const documents = [...incoming];
  database.transaction(() => {
    const tagAliases = buildTagAliases(database, documents);
    applyTombstones(database, documents, tagAliases);
    applyUpserts(database, attachments, documents, tagAliases, workspacePath);
  });
  return { documentCount: documents.length };
}

export interface ImportSyncedInput {
  id: string;
  noteId: string;
  storedFileName: string;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

function buildTagAliases(
  database: CardNoteDatabase,
  documents: SyncDocument[],
): Map<string, string> {
  const deletedTagIds = new Set(
    documents.filter((d) => d.deleted && d.type === 'tag').map((d) => d.id),
  );
  const existingByNormalizedName = new Map<string, string>();
  for (const tag of database.listTags()) {
    if (!deletedTagIds.has(tag.id)) {
      existingByNormalizedName.set(tag.normalizedName, tag.id);
    }
  }
  const groups = new Map<string, SyncDocument[]>();
  for (const document of documents) {
    if (document.deleted || document.type !== 'tag') continue;
    const normalizedName = document.fields['normalizedName'] as string;
    const group = groups.get(normalizedName) ?? [];
    group.push(document);
    groups.set(normalizedName, group);
  }
  const aliases = new Map<string, string>();
  for (const [normalizedName, group] of groups) {
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const canonicalId = existingByNormalizedName.get(normalizedName) ?? sorted[0]?.id ?? '';
    for (const document of sorted) {
      aliases.set(document.id, canonicalId);
    }
  }
  return aliases;
}

function applyTombstones(
  database: CardNoteDatabase,
  documents: SyncDocument[],
  tagAliases: Map<string, string>,
): void {
  const deleted = documents.filter((d) => d.deleted);
  for (const document of deleted.filter((d) => d.type === 'note-tag')) {
    const separator = document.id.indexOf('--');
    if (separator <= 0 || separator === document.id.length - 2) {
      throw new Error(`标签关联 tombstone 身份无效：${document.id}`);
    }
    const noteId = document.id.slice(0, separator);
    const incomingTagId = document.id.slice(separator + 2);
    database.deleteNoteTagRow(noteId, tagAliases.get(incomingTagId) ?? incomingTagId);
  }
  for (const document of deleted.filter((d) => d.type === 'attachment')) {
    database.deleteAttachmentRow(document.id);
  }
  for (const document of deleted.filter((d) => d.type === 'note')) {
    database.deleteNoteRowDirect(document.id);
  }
  for (const document of deleted.filter((d) => d.type === 'book')) {
    database.deleteBookRowDirect(document.id);
  }
  for (const document of deleted.filter((d) => d.type === 'tag')) {
    database.deleteTagRowDirect(document.id);
  }
}

function applyUpserts(
  database: CardNoteDatabase,
  attachments: { importSynced(input: ImportSyncedInput & { sourcePath: string }): void },
  documents: SyncDocument[],
  tagAliases: Map<string, string>,
  workspacePath: string | null,
): void {
  const active = documents.filter((d) => !d.deleted);
  for (const document of active.filter((d) => d.type === 'book')) {
    database.upsertBookRow({
      id: document.id,
      title: document.fields['title'] as string,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    });
  }
  mergeTags(database, documents, tagAliases);
  for (const document of active.filter((d) => d.type === 'note')) {
    database.upsertNoteRow({
      id: document.id,
      bookId: document.fields['bookId'] as string,
      quote: document.fields['quote'] as string,
      comment: (document.fields['comment'] as string | null) ?? null,
      pageStart: (document.fields['pageStart'] as number | null) ?? null,
      pageEnd: (document.fields['pageEnd'] as number | null) ?? null,
      contentRevision: document.fields['contentRevision'] as number,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    });
  }
  for (const document of active.filter((d) => d.type === 'note-tag')) {
    const noteId = document.fields['noteId'] as string;
    const incomingTagId = document.fields['tagId'] as string;
    const tagId = tagAliases.get(incomingTagId) ?? incomingTagId;
    // 孤儿关联（引用不存在的笔记或标签）静默跳过。
    if (database.getNote(noteId) === null) continue;
    if (database.getTagRow(tagId) === null) continue;
    database.upsertNoteTagRow({
      noteId,
      tagId,
      source: document.fields['source'] as string,
      createdAt: document.createdAt,
    });
  }
  for (const document of active.filter((d) => d.type === 'attachment')) {
    if (workspacePath === null) {
      throw new Error('导入附件需要同步工作区');
    }
    const noteId = document.fields['noteId'] as string;
    if (database.getNote(noteId) === null) continue;
    attachments.importSynced({
      id: document.id,
      noteId,
      storedFileName: document.fields['storedFileName'] as string,
      originalFileName: document.fields['originalFileName'] as string,
      mimeType: document.fields['mimeType'] as string,
      byteSize: document.fields['byteSize'] as number,
      width: (document.fields['width'] as number | null) ?? null,
      height: (document.fields['height'] as number | null) ?? null,
      sortOrder: document.fields['sortOrder'] as number,
      contentHash: document.fields['contentHash'] as string,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      sourcePath: join(join(workspacePath, 'assets'), document.fields['storedFileName'] as string),
    });
  }
}

function mergeTags(
  database: CardNoteDatabase,
  documents: SyncDocument[],
  tagAliases: Map<string, string>,
): void {
  const groups = new Map<string, SyncDocument[]>();
  for (const document of documents) {
    if (document.deleted || document.type !== 'tag') continue;
    const normalizedName = document.fields['normalizedName'] as string;
    const group = groups.get(normalizedName) ?? [];
    group.push(document);
    groups.set(normalizedName, group);
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => {
      const byUpdatedAt = right.updatedAt - left.updatedAt;
      return byUpdatedAt !== 0 ? byUpdatedAt : left.id.localeCompare(right.id);
    });
    const winner = sorted[0];
    if (winner === undefined) continue;
    const canonicalId = tagAliases.get(winner.id) ?? winner.id;
    const existingCanonical = database.getTagRow(canonicalId);
    const fields = winner.fields;
    const earliestCreatedAt = group
      .map((document) => document.createdAt)
      .reduce<number>((a, b) => (a < b ? a : b), winner.createdAt);
    database.upsertTagRow({
      id: canonicalId,
      name: fields['name'] as string,
      normalizedName: fields['normalizedName'] as string,
      createdAt:
        existingCanonical === null
          ? earliestCreatedAt
          : Math.min(existingCanonical.createdAt, earliestCreatedAt),
      updatedAt: winner.updatedAt,
    });
    for (const document of group) {
      if (document.id === canonicalId) continue;
      // 重复标签的关联迁移到 canonical 后删除重复行。
      for (const association of database.getNoteTagsForTag(document.id)) {
        database.upsertNoteTagRow({
          noteId: association.noteId,
          tagId: canonicalId,
          source: association.source,
          createdAt: association.createdAt,
        });
      }
      database.deleteNoteTagsForTag(document.id);
      database.deleteTagRowDirect(document.id);
    }
  }
}

import { writeFileSync, readFileSync } from 'node:fs';
import type { CardNoteDatabase, Note } from './database.ts';

/**
 * 单本书导出/导入（迁移自 card_note `lib/features/export/data/book_export_service.dart`）。
 * 导出格式与 card_note v1.0 逐字段一致（可作旧版导出文件的回归基准）：
 * Markdown 按 createdAt 升序逐条输出区块；JSON 为 formatVersion 1 的结构化数据。
 * 导入始终作为新书副本（笔记生成新 UUID，标签按归一化名复用）；导出不包含链接与附件（源即如此）。
 */

export type ExportFormat = 'markdown' | 'json';

export interface ExportPreview {
  readonly content: string;
  readonly suggestedFileName: string;
}

export interface ExportWritten {
  readonly written: true;
  readonly byteSize: number;
}

export interface ImportResult {
  readonly bookId: string;
  readonly title: string;
  readonly noteCount: number;
}

export function suggestedFileName(
  book: { id: string; title: string },
  format: ExportFormat,
): string {
  const safeTitle = book.title.replaceAll(/[\\/:*?"<>|]/g, '_').trim();
  const title = safeTitle === '' ? `book-${book.id}` : safeTitle;
  return `${title}.${format === 'markdown' ? 'md' : 'json'}`;
}

function pageLabel(pageStart: number | null, pageEnd: number | null): string {
  if (pageStart === null) return '未填写';
  if (pageStart === pageEnd) return `第 ${pageStart} 页`;
  return `第 ${pageStart}-${pageEnd} 页`;
}

function formatTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/** 构建导出内容（不含落盘）；nowIso 供测试注入确定性的导出时间。 */
export function buildExport(
  database: CardNoteDatabase,
  bookId: string,
  format: ExportFormat,
  options: { nowIso?: string } = {},
): ExportPreview {
  const book = database.getBook(bookId);
  if (book === null) {
    throw new Error('书籍不存在或已被删除');
  }
  const notes = [...database.listNotes(bookId)]
    .sort((left, right) => {
      const byCreatedAt = left.createdAt - right.createdAt;
      return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id);
    })
    .map((note) => ({ note, tags: database.getTagsForNote(note.id).map((tag) => tag.name) }));
  const content =
    format === 'markdown'
      ? toMarkdown(book.title, notes, options.nowIso ?? new Date().toISOString())
      : toJson(book, notes, options.nowIso ?? new Date().toISOString());
  return { content, suggestedFileName: suggestedFileName(book, format) };
}

/** 构建并写入用户经保存对话框确认的目标路径。 */
export function writeExport(
  database: CardNoteDatabase,
  bookId: string,
  format: ExportFormat,
  targetPath: string,
  options: { nowIso?: string } = {},
): ExportWritten {
  const preview = buildExport(database, bookId, format, options);
  writeFileSync(targetPath, preview.content, 'utf-8');
  return { written: true, byteSize: Buffer.byteLength(preview.content, 'utf-8') };
}

function toMarkdown(
  title: string,
  entries: Array<{ note: Note; tags: string[] }>,
  nowIso: string,
): string {
  const buffer = [`# ${title}`, '', `> 导出时间：${nowIso}`, `> 笔记数量：${entries.length}`, ''];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const { note, tags } = entry;
    buffer.push(
      '---',
      '',
      `## 笔记 ${index + 1}`,
      '',
      `**创建时间：** ${formatTimestamp(note.createdAt)}`,
      `**页码：** ${pageLabel(note.pageStart, note.pageEnd)}`,
      `**标签：** ${tags.length === 0 ? '无' : tags.join('、')}`,
      '',
      '### 原文',
      note.quote,
      '',
      '### 备注',
      note.comment !== null && note.comment.trim() !== '' ? note.comment : '（无）',
      '',
    );
  }
  return buffer.join('\n');
}

function toJson(
  book: { id: string; title: string; createdAt: number; updatedAt: number },
  entries: Array<{
    note: {
      id: string;
      quote: string;
      comment: string | null;
      pageStart: number | null;
      pageEnd: number | null;
      contentRevision: number;
      createdAt: number;
      updatedAt: number;
    };
    tags: string[];
  }>,
  nowIso: string,
): string {
  const value = {
    formatVersion: 1,
    exportedAt: nowIso,
    book: { id: book.id, title: book.title, createdAt: book.createdAt, updatedAt: book.updatedAt },
    notes: entries.map(({ note, tags }) => ({
      id: note.id,
      quote: note.quote,
      comment: note.comment,
      pageStart: note.pageStart,
      pageEnd: note.pageEnd,
      tags,
      contentRevision: note.contentRevision,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })),
  };
  return JSON.stringify(value, null, 2);
}

/** 读取并导入 JSON 导出文件（源 importJson：新书副本 + 逐条校验）。 */
export function importFromPath(database: CardNoteDatabase, sourcePath: string): ImportResult {
  let source: string;
  try {
    source = readFileSync(sourcePath, 'utf-8');
  } catch {
    throw new Error('无法读取导入文件');
  }
  return importFromJsonString(database, source);
}

export function importFromJsonString(database: CardNoteDatabase, source: string): ImportResult {
  const parsed = parseJsonImport(source);
  let importedBookId = '';
  database.transaction(() => {
    const book = database.createBook(parsed.title);
    importedBookId = book.id;
    for (const entry of parsed.notes) {
      const tagIds = new Set<string>();
      for (const tagName of entry.tags) {
        tagIds.add(database.ensureTag(tagName).id);
      }
      database.saveNote({
        noteId: null,
        bookId: book.id,
        quote: entry.quote,
        comment: entry.comment,
        pageStart: entry.pageStart,
        pageEnd: entry.pageEnd,
        tagIds: [...tagIds],
      });
    }
  });
  const importedBook = database.getBook(importedBookId);
  if (importedBook === null) {
    throw new Error('导入失败：书籍写入未生效');
  }
  return { bookId: importedBook.id, title: importedBook.title, noteCount: parsed.notes.length };
}

interface ParsedImportNote {
  readonly quote: string;
  readonly comment: string | null;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly tags: string[];
}

function parseJsonImport(source: string): { title: string; notes: ParsedImportNote[] } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error('无法解析 JSON 文件');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    (decoded as { formatVersion?: unknown }).formatVersion !== 1
  ) {
    throw new Error('这不是 Card Note 的 JSON 导出文件');
  }
  const record = decoded as Record<string, unknown>;
  const book = record['book'];
  const notes = record['notes'];
  if (typeof book !== 'object' || book === null || !Array.isArray(notes)) {
    throw new Error('导出文件缺少书籍或笔记数据');
  }
  const title = (book as Record<string, unknown>)['title'];
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('导出文件中的书名无效');
  }
  const importedNotes: ParsedImportNote[] = [];
  for (let index = 0; index < notes.length; index++) {
    const label = `第 ${index + 1} 条笔记`;
    const value = notes[index];
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${label}格式无效`);
    }
    const entry = value as Record<string, unknown>;
    const quote = entry['quote'];
    const comment = entry['comment'];
    const pageStart = entry['pageStart'];
    const pageEnd = entry['pageEnd'];
    const tags = entry['tags'];
    if (typeof quote !== 'string' || quote.trim() === '') {
      throw new Error(`${label}的原文无效`);
    }
    // 缺键与显式 null 均视为无备注（Dart 版缺键即 null）。
    if (comment !== null && comment !== undefined && typeof comment !== 'string') {
      throw new Error(`${label}的备注无效`);
    }
    const pagesValid =
      (pageStart === null && pageEnd === null) ||
      (typeof pageStart === 'number' &&
        Number.isInteger(pageStart) &&
        typeof pageEnd === 'number' &&
        Number.isInteger(pageEnd) &&
        pageStart >= 1 &&
        pageEnd >= pageStart);
    if (!pagesValid) {
      throw new Error(`${label}的页码无效`);
    }
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
      throw new Error(`${label}的标签无效`);
    }
    importedNotes.push({
      quote,
      comment: typeof comment === 'string' ? comment : null,
      pageStart: typeof pageStart === 'number' ? pageStart : null,
      pageEnd: typeof pageEnd === 'number' ? pageEnd : null,
      tags: tags as string[],
    });
  }
  return { title: title.trim(), notes: importedNotes };
}

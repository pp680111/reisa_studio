/**
 * 领域校验（迁移自 card_note `lib/features/notes/domain/note_validation.dart`）。
 * 页码在 UI 可输入单页或范围字符串，领域层统一保存为 pageStart/pageEnd；
 * 规则明细见迁移设计文档 §5.1 V3/V4。
 */

export interface PageRange {
  readonly start: number;
  readonly end: number;
}

export class NoteValidationError extends Error {}

export function parsePageRange(raw: string): PageRange | null {
  const input = raw.trim();
  if (input === '') {
    return null;
  }
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(input);
  if (match === null) {
    throw new NoteValidationError('页码只能填写单页数字或页码范围，例如 12 或 12-15');
  }
  const start = Number.parseInt(match[1] ?? '', 10);
  const end = match[2] !== undefined ? Number.parseInt(match[2], 10) : start;
  if (!(start > 0) || end < start) {
    throw new NoteValidationError('页码必须为正整数，且结束页不能小于起始页');
  }
  return { start, end };
}

/**
 * 摘录与正文至少其一非空（v0.2 起：摘录不再必填，支持无摘录的纯笔记）。
 * 返回去首尾空白后的摘录；正文空串在保存时归一化为 null。
 */
export function validateNoteContent(rawQuote: string, rawComment: string | null): string {
  const quote = rawQuote.trim();
  const comment = rawComment?.trim() ?? '';
  if (quote === '' && comment === '') {
    throw new NoteValidationError('摘录与正文不能同时为空');
  }
  return quote;
}

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

export function validateQuote(raw: string): string {
  const quote = raw.trim();
  if (quote === '') {
    throw new NoteValidationError('原文不能为空');
  }
  return quote;
}

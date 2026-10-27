/**
 * 领域校验（迁移自 card_note `lib/features/notes/domain/note_validation.dart`）。
 * 页码编辑已移除，pageStart/pageEnd 仅作为既有数据随保存透传。
 */

export class NoteValidationError extends Error {}

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

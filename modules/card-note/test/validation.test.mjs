/**
 * 领域校验单测（移植自 card_note test/note_validation_test.dart；页码解析已随页码编辑移除）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNoteContent } from '../domain/validation.ts';

test('内容校验：摘录与正文至少其一非空，返回去空白摘录', () => {
  assert.equal(validateNoteContent('  原文内容  ', null), '原文内容');
  assert.equal(validateNoteContent('', '  只有正文  '), '');
  assert.equal(validateNoteContent('摘录', '正文'), '摘录');
  assert.throws(() => validateNoteContent('  ', null), /摘录与正文不能同时为空/);
  assert.throws(() => validateNoteContent('  ', '   '), /摘录与正文不能同时为空/);
});

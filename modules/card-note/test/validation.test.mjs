/**
 * 领域校验单测（移植自 card_note test/note_validation_test.dart）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePageRange, validateNoteContent } from '../domain/validation.ts';

test('单页解析为起止相同', () => {
  assert.deepEqual(parsePageRange('12'), { start: 12, end: 12 });
});

test('页码范围允许空白', () => {
  assert.deepEqual(parsePageRange('12 - 15'), { start: 12, end: 15 });
});

test('空页码返回 null', () => {
  assert.equal(parsePageRange(''), null);
  assert.equal(parsePageRange('   '), null);
});

test('非法页码被拒绝', () => {
  assert.throws(() => parsePageRange('15-12'), /结束页不能小于起始页/);
  assert.throws(() => parsePageRange('page 12'), /页码只能填写单页数字/);
  assert.throws(() => parsePageRange('0'), /页码必须为正整数/);
});

test('内容校验：摘录与正文至少其一非空，返回去空白摘录', () => {
  assert.equal(validateNoteContent('  原文内容  ', null), '原文内容');
  assert.equal(validateNoteContent('', '  只有正文  '), '');
  assert.equal(validateNoteContent('摘录', '正文'), '摘录');
  assert.throws(() => validateNoteContent('  ', null), /摘录与正文不能同时为空/);
  assert.throws(() => validateNoteContent('  ', '   '), /摘录与正文不能同时为空/);
});

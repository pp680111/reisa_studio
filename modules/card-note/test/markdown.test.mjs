/** Markdown 工具单测（tabularTextToMarkdown，迁移自 card_note markdown_text.dart）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tabularTextToMarkdown } from '../runtime/markdown.ts';

test('制表符文本转换为 Markdown 表格', () => {
  assert.equal(
    tabularTextToMarkdown('列A\t列B\n甲\t乙'),
    '| 列A | 列B |\n| --- | --- |\n| 甲 | 乙 |',
  );
});

test('单元格首尾空白被修剪，竖线被转义', () => {
  assert.equal(tabularTextToMarkdown(' a\tb|c \n1\t2'), '| a | b\\|c |\n| --- | --- |\n| 1 | 2 |');
});

test('非表格输入返回 null', () => {
  assert.equal(tabularTextToMarkdown('普通文本'), null);
  assert.equal(tabularTextToMarkdown('只有一行\t带制表符'), null);
  assert.equal(tabularTextToMarkdown(''), null);
});

test('列数不一致的输入返回 null', () => {
  assert.equal(tabularTextToMarkdown('a\tb\n多出来的列\tb\tc'), null);
});

test('CRLF 与末尾空行被容忍', () => {
  assert.equal(tabularTextToMarkdown('a\tb\r\n1\t2\r\n'), '| a | b |\n| --- | --- |\n| 1 | 2 |');
});

/**
 * 排除规则测试（移植自 skb tests/unit/test_ignore.py 的规则用例）。
 * 隐藏目录 / node_modules / __pycache__ 不可覆盖，目录剪枝在 scanner 测试覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IgnoreRules } from '../runtime/ignore.ts';

const cases = [
  ['# comment\n\n*.draft.md', 'sub/a.draft.md', false, true],
  ['/archive/', 'archive/a.md', false, true],
  ['/archive/', 'sub/archive/a.md', false, false],
  ['temp/', 'sub/temp/a.md', false, true],
  ['**/secret.md', 'a/b/secret.md', false, true],
  ['/notes/*.md\n!/notes/README.md', 'notes/README.md', false, false],
  ['/notes/*.md\n!/notes/README.md', 'notes/other.md', false, true],
  // 父目录被排除时负向规则无法恢复文件
  ['notes/\n!notes/README.md', 'notes/README.md', false, true],
  // 先恢复父目录再恢复文件
  ['notes/\n!notes/\n!notes/README.md', 'notes/README.md', false, false],
  // 隐藏目录不可覆盖（祖先剪枝语义）
  ['!.hidden/\n!.hidden/a.md', '.hidden/a.md', false, true],
  ['!.hidden/', '.hidden', true, true],
  ['!node_modules/\n!node_modules/a.md', 'node_modules/a.md', false, true],
  // 隐藏文件不属于默认排除
  ['', '.note.md', false, false],
  ['\\#note.md', '#note.md', false, true],
  ['a?.md', 'ab.md', false, true],
];

for (const [rules, path, isDirectory, expected] of cases) {
  test(`规则 ${JSON.stringify(rules)} 对 ${path}${isDirectory ? '(目录)' : ''} → ${expected}`, () => {
    assert.equal(new IgnoreRules(rules).excludes(path, { isDirectory }), expected);
  });
}

test('规则长度上限', () => {
  assert.throws(() => new IgnoreRules('a'.repeat(64_001)), /64000/);
  assert.doesNotThrow(() => new IgnoreRules('a'.repeat(64_000)));
});

test('包含 NUL 的行被拒绝', () => {
  assert.throws(() => new IgnoreRules('ok\n\0bad'), /第 2 行/);
});

test('空规则与注释行', () => {
  const rules = new IgnoreRules('# 只是注释\n\n');
  assert.equal(rules.excludes('anything.md'), false);
});

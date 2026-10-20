/**
 * 文件工具测试：在临时 fixture 仓库上验证 ls / read_file / glob / grep 的
 * 行为与上限（截断、二进制跳过、CRLF 归一、ignore 规则），并断言
 * 所有输出路径都是仓库内相对/虚拟形态（不含宿主机绝对路径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  listDirectory,
  loadIgnoreMatcher,
  readFileLines,
  grepTree,
  makeGlobFilter,
  ToolFileError,
} from '../runtime/tools.ts';
import { toPosixPath } from '../runtime/tools.ts';

let root;
let matcher;

test.before(() => {
  root = mkdtempSync(join(tmpdir(), 're-tools-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const greeting = "hello world";\nexport function main() {\n  return greeting;\n}\n');
  writeFileSync(join(root, 'src', 'util.ts'), '// utils\nexport const add = (a, b) => a + b;\n');
  writeFileSync(join(root, 'docs', 'readme.md'), '# demo\nhello docs\n');
  writeFileSync(join(root, 'skip-me.js'), 'hello from ignored dir\n');
  writeFileSync(join(root, 'notes.txt'), 'first\r\nsecond\r\nthird\r\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0x4c, 0x56, 0x00, 0x01, 0x02]));
  writeFileSync(join(root, '.gitignore'), 'docs/\n');
  matcher = null;
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

async function ensureMatcher() {
  matcher ??= await loadIgnoreMatcher(root);
  return matcher;
}

test('loadIgnoreMatcher：内建目录 + .gitignore 规则同时生效', async () => {
  const m = await ensureMatcher();
  assert.equal(m.ignores('node_modules/skip-me.js'), true);
  assert.equal(m.ignores('docs/readme.md'), true);
  assert.equal(m.ignores('src/main.ts'), false);
  assert.equal(m.ignores(''), false);
});

test('listDirectory：目录优先排序并返回文件大小', async () => {
  const { entries, truncated } = await listDirectory(root, 1000);
  assert.equal(truncated, false);
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes('src') && names.includes('docs'));
  const first = entries[0];
  assert.equal(first.type, 'directory');
  const text = entries.find((entry) => entry.name === 'notes.txt');
  assert.equal(text.size, 'first\r\nsecond\r\nthird\r\n'.length);
});

test('listDirectory：超过 limit 截断', async () => {
  const { entries, truncated } = await listDirectory(root, 2);
  assert.equal(entries.length, 2);
  assert.equal(truncated, true);
});

test('readFileLines：CRLF 归一并按行窗口返回', async () => {
  const page = await readFileLines(join(root, 'notes.txt'), 2, 2);
  assert.deepEqual(page.content.split('\n'), ['second', 'third']);
  assert.equal(page.startLine, 2);
  assert.equal(page.endLine, 3);
  assert.equal(page.truncated, false);
});

test('readFileLines：末页不误报截断，中页正确报截断', async () => {
  const full = await readFileLines(join(root, 'src', 'main.ts'), 1, 100);
  assert.equal(full.truncated, false);
  assert.equal(full.endLine, 4);
  const middle = await readFileLines(join(root, 'src', 'main.ts'), 1, 2);
  assert.equal(middle.truncated, true);
  assert.equal(middle.endLine, 2);
});

test('readFileLines：二进制文件拒绝并提示', async () => {
  await assert.rejects(
    () => readFileLines(join(root, 'binary.bin'), 1, 10),
    (error) => error instanceof ToolFileError && error.code === 'binary_file',
  );
});

test('readFileLines：超过 512KB 只读前段并标记截断', async () => {
  const bigPath = join(root, 'big.txt');
  const line = `${'a'.repeat(99)}\n`;
  writeFileSync(bigPath, line.repeat(6000)); // ~600KB
  const page = await readFileLines(bigPath, 1, 2000);
  assert.equal(page.truncated, true);
  assert.equal(page.startLine, 1);
  assert.ok(page.content.length > 0);
  assert.ok(!page.content.includes('\u0000'));
});

test('grepTree：正则命中、虚拟前缀拼接与忽略规则', async () => {
  const m = await ensureMatcher();
  const outcome = await grepTree({
    root,
    virtualPrefix: '/repos/demo/',
    regex: /hello/,
    fileFilter: makeGlobFilter(undefined),
    maxCount: 50,
    matcher: m,
  });
  const paths = outcome.matches.map((match) => match.path);
  assert.ok(paths.includes('/repos/demo/src/main.ts'));
  // node_modules 与 .gitignore 命中的 docs/ 不进结果
  assert.ok(!paths.some((p) => p.startsWith('/repos/demo/node_modules/')));
  assert.ok(!paths.includes('/repos/demo/docs/readme.md'));
  // binary.bin 被 NUL 嗅探跳过
  assert.ok(!paths.includes('/repos/demo/binary.bin'));
  assert.ok(outcome.filesSearched >= 3);
  assert.equal(outcome.truncated, false);
  // 输出不含宿主机绝对路径
  for (const match of outcome.matches) {
    assert.ok(!match.path.includes(root), `输出泄露绝对路径：${match.path}`);
    assert.ok(match.snippet.includes('hello'));
  }
});

test('grepTree：glob 过滤只保留匹配文件', async () => {
  const m = await ensureMatcher();
  const outcome = await grepTree({
    root,
    virtualPrefix: '/repos/demo/',
    regex: /hello/,
    fileFilter: makeGlobFilter('*.ts'),
    maxCount: 50,
    matcher: m,
  });
  for (const match of outcome.matches) {
    assert.ok(match.path.endsWith('.ts'), `应只命中 .ts：${match.path}`);
  }
});

test('grepTree：maxCount 截断', async () => {
  const m = await ensureMatcher();
  const outcome = await grepTree({
    root,
    virtualPrefix: '/repos/demo/',
    regex: /./,
    fileFilter: makeGlobFilter('notes.txt'),
    maxCount: 2,
    matcher: m,
  });
  assert.equal(outcome.matches.length, 2);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.filesSearched, 1);
});

test('toPosixPath：Windows 分隔符归一', () => {
  if (sep === '\\') {
    assert.equal(toPosixPath('a\\b\\c.ts'), 'a/b/c.ts');
  } else {
    assert.equal(toPosixPath('a/b/c.ts'), 'a/b/c.ts');
  }
});

/**
 * 沙箱校验测试：resolveVirtualPath 的拒绝面与合法解析、
 * validateSearchPattern 的 glob/正则参数校验、verifyWithinRepo 的符号链接逃逸防护。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { resolveVirtualPath, SandboxError, validateSearchPattern, verifyWithinRepo } from '../runtime/sandbox.ts';

/** 构造已 realpath 归一化的注册项（与生产登记语义一致）。 */
function makeRepo(name, path, enabled = true) {
  return {
    id: `repo_${name}`,
    name,
    path: resolve(path),
    tags: [],
    description: '',
    enabled,
    createdAt: 0,
  };
}

function registry(...repos) {
  return repos;
}

test('根路径、省略路径与点路径全部拒绝', () => {
  const repos = registry(makeRepo('demo', '/tmp/demo'));
  for (const bad of ['', '   ', '.', '/', '/.', '\\', './']) {
    assert.throws(() => resolveVirtualPath(repos, bad), SandboxError, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('家目录、盘符与宿主机绝对路径拒绝', () => {
  const repos = registry(makeRepo('demo', '/tmp/demo'));
  for (const bad of ['~', '~/repo', 'C:/tmp', 'c:/tmp', '/C:/tmp', 'E:\\product\\demo']) {
    assert.throws(() => resolveVirtualPath(repos, bad), SandboxError, `应拒绝：${bad}`);
  }
});

test('.. 穿越与空路径段拒绝', () => {
  const repos = registry(makeRepo('demo', '/tmp/demo'));
  for (const bad of ['/repos/demo/../other', '/repos/../demo', '/repos/demo//x', '/repos/demo/./x']) {
    assert.throws(() => resolveVirtualPath(repos, bad), SandboxError, `应拒绝：${bad}`);
  }
});

test('未注册与已停用仓库名拒绝（RESOURCE_NOT_FOUND 语义）', () => {
  const repos = registry(makeRepo('demo', '/tmp/demo'), makeRepo('off', '/tmp/off', false));
  const unknown = (() => {
    try {
      resolveVirtualPath(repos, '/repos/missing/x');
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(unknown.code, 'unregistered_repo');
  assert.throws(() => resolveVirtualPath(repos, '/repos/off/x'), (error) => error.code === 'unregistered_repo');
});

test('合法路径解析：仓库根、子目录、反斜杠归一化、大小写仓库名', () => {
  const root = resolve('/tmp/demo');
  const repos = registry(makeRepo('demo', root), makeRepo('Media-Service', '/tmp/ms'));
  const repoRoot = resolveVirtualPath(repos, '/repos/demo/');
  assert.equal(repoRoot.relativePart, '');
  assert.equal(repoRoot.absolutePath, root);
  assert.equal(repoRoot.virtualPath, '/repos/demo/');

  const file = resolveVirtualPath(repos, '/repos/demo/src/main.ts');
  assert.equal(file.relativePart, 'src/main.ts');
  assert.equal(file.absolutePath, join(root, 'src', 'main.ts'));
  assert.equal(file.virtualPath, '/repos/demo/src/main.ts');

  const backslash = resolveVirtualPath(repos, '/repos/demo\\src\\main.ts');
  assert.equal(backslash.relativePart, 'src/main.ts');

  const upper = resolveVirtualPath(repos, '/repos/Media-Service/');
  assert.equal(upper.repo.name, 'Media-Service');
});

test('glob 模式校验：拒绝绝对路径与 ..，正则只要求可编译', () => {
  for (const bad of ['../x', '/abs/**/*.ts', 'c:/x/*.ts']) {
    assert.throws(() => validateSearchPattern(bad, 'glob'), SandboxError, `glob 应拒绝：${bad}`);
  }
  assert.equal(validateSearchPattern('src/**/*.ts', 'glob'), 'src/**/*.ts');

  // 正则保留反斜杠语义：\d 合法；未闭合组拒绝
  assert.equal(validateSearchPattern('\\d+', 'regex'), '\\d+');
  assert.throws(() => validateSearchPattern('([unclosed', 'regex'), SandboxError);
  assert.throws(() => validateSearchPattern('   ', 'regex'), SandboxError);
});

test('verifyWithinRepo：符号链接指向仓库外时拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 're-sandbox-'));
  const outside = mkdtempSync(join(tmpdir(), 're-outside-'));
  try {
    const repo = makeRepo('demo', root);
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'top secret');
    let linked = false;
    try {
      symlinkSync(outside, join(root, 'link-out'), 'junction');
      linked = true;
    } catch {
      // 无符号链接权限的环境跳过该断言
    }
    if (linked) {
      const target = resolveVirtualPath([repo], '/repos/demo/link-out/secret.txt');
      assert.equal(target.absolutePath, join(root, 'link-out', 'secret.txt'));
      await assert.rejects(() => verifyWithinRepo(repo, target.absolutePath), SandboxError);
    }
    // 正常仓库内文件放行
    const inside = join(root, 'inside.txt');
    writeFileSync(inside, 'ok');
    await assert.doesNotReject(() => verifyWithinRepo(repo, inside));
    // 不存在的目标放行（由后续文件操作报不存在）
    await assert.doesNotReject(() => verifyWithinRepo(repo, join(root, 'missing.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

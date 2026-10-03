/**
 * 目录扫描测试（移植自 skb tests/unit/test_scanner.py 与 test_ignore.py 的目录剪枝用例）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDirectory } from '../runtime/scanner.ts';
import { IgnoreRules } from '../runtime/ignore.ts';

test('扫描过滤隐藏目录、缓存目录与不支持的格式（skb 用例）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-scan-'));
  await writeFile(join(root, 'readme.md'), 'hello', 'utf-8');
  await writeFile(join(root, 'notes.txt'), 'hello', 'utf-8');
  await writeFile(join(root, 'image.png'), Buffer.from([0x89, 0x50]));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config.md'), 'secret', 'utf-8');
  await mkdir(join(root, '__pycache__'));
  await writeFile(join(root, '__pycache__', 'junk.md'), 'junk', 'utf-8');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'deep.md'), 'deep', 'utf-8');

  const snapshots = await scanDirectory(root);
  assert.deepEqual(snapshots.map((s) => s.relPath).sort(), [
    'notes.txt',
    'readme.md',
    'sub/deep.md',
  ]);
});

test('被排除的目录整枝剪掉，不进入其子树（skb 目录剪枝用例）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-scan-'));
  await mkdir(join(root, 'private'));
  await writeFile(join(root, 'private', 'secret.md'), 'secret', 'utf-8');
  await writeFile(join(root, 'ok.md'), 'ok', 'utf-8');

  const seen = [];
  const snapshots = await scanDirectory(root, new IgnoreRules('private/'));
  void seen;
  assert.deepEqual(
    snapshots.map((s) => s.relPath),
    ['ok.md'],
  );
});

test('快照包含纳秒级 mtime 与 size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-scan-'));
  await writeFile(join(root, 'a.md'), 'hello', 'utf-8');
  const snapshots = await scanDirectory(root);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.size, 5);
  assert.equal(typeof snapshots[0]?.mtimeNs, 'bigint');
  assert.ok(snapshots[0]?.mtimeNs > 0n);
});

test('负向规则无法恢复默认排除目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-scan-'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'pkg.md'), 'x', 'utf-8');
  await writeFile(join(root, 'keep.md'), 'x', 'utf-8');
  const snapshots = await scanDirectory(root, new IgnoreRules('!node_modules/'));
  assert.deepEqual(
    snapshots.map((s) => s.relPath),
    ['keep.md'],
  );
});

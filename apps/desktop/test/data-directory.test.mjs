/**
 * 数据目录自定义回归（架构设计 §7.2 存储根可配置）：
 * 指针解析与回落语义；迁移目标校验；迁移复制 + 内嵌绝对路径改写 + 校验失败回滚。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  clearDataRootPointer,
  defaultAppDataRoot,
  migrateAppData,
  readDataRootPointer,
  resolveAppDataRoot,
  validateMigrationTarget,
  writeDataRootPointer,
} from '../src/composition/data-directory.ts';

/** 递归列出目录下全部文件的相对路径（排序后用于前后对账）。 */
async function listFiles(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(join(root, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

/** 造一个最小的 app-data 源目录：两个内嵌绝对路径库 + 普通文件。 */
async function makeSourceAppData(sourceRoot, options = {}) {
  const oldAttachmentsDir = join(sourceRoot, 'main', 'attachments');
  const oldKnowledgeDir = join(sourceRoot, 'modules', 'knowledge');
  await mkdir(join(oldAttachmentsDir, 'conv_1'), { recursive: true });
  await mkdir(join(oldKnowledgeDir, 'files', 'uploads'), { recursive: true });
  await mkdir(join(sourceRoot, 'foundation'), { recursive: true });
  await mkdir(join(sourceRoot, 'modules', 'card-note'), { recursive: true });
  await mkdir(join(sourceRoot, 'modules', 'todo'), { recursive: true });
  await writeFile(join(sourceRoot, 'foundation', 'settings.json'), '{}', 'utf8');
  await writeFile(join(oldAttachmentsDir, 'conv_1', 'att_x-report.pdf'), 'pdf-bytes', 'utf8');
  await writeFile(join(oldKnowledgeDir, 'files', 'uploads', 'a.md'), '# a', 'utf8');

  if (options.corruptConversationsDb) {
    await writeFile(join(sourceRoot, 'main', 'conversations.sqlite'), 'not a sqlite file', 'utf8');
  } else {
    const conversations = new DatabaseSync(join(sourceRoot, 'main', 'conversations.sqlite'));
    conversations.exec('CREATE TABLE attachments (id TEXT PRIMARY KEY, path TEXT NOT NULL)');
    conversations
      .prepare('INSERT INTO attachments (id, path) VALUES (?, ?)')
      .run('att_1', join(oldAttachmentsDir, 'conv_1', 'att_x-report.pdf'));
    conversations
      .prepare('INSERT INTO attachments (id, path) VALUES (?, ?)')
      .run('att_external', join('D:\\elsewhere', 'x.png'));
    conversations.close();
  }

  // knowledge 的库为 WAL 模式（迁移后靠关闭时 checkpoint 保证副本一致）
  const knowledge = new DatabaseSync(join(sourceRoot, 'modules', 'knowledge', 'data.sqlite'));
  knowledge.exec('PRAGMA journal_mode=WAL');
  knowledge.exec('CREATE TABLE sources (id TEXT PRIMARY KEY, path TEXT NOT NULL)');
  knowledge
    .prepare('INSERT INTO sources (id, path) VALUES (?, ?)')
    .run('src_uploads', join(oldKnowledgeDir, 'files', 'uploads'));
  knowledge.prepare('INSERT INTO sources (id, path) VALUES (?, ?)').run('src_docs', 'D:\\docs');
  knowledge.close();

  const cardNote = new DatabaseSync(join(sourceRoot, 'modules', 'card-note', 'card-note.sqlite'));
  cardNote.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
  cardNote.close();
  const todo = new DatabaseSync(join(sourceRoot, 'modules', 'todo', 'todo.sqlite'));
  todo.exec('CREATE TABLE category (id TEXT PRIMARY KEY)');
  todo.close();
}

test('resolveAppDataRoot：无指针回落默认位置', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'reisa-datadir-'));
  try {
    assert.equal(await resolveAppDataRoot(userData), defaultAppDataRoot(userData));
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('resolveAppDataRoot：有效指针指向自定义根', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'reisa-datadir-'));
  const custom = join(userData, 'custom-root');
  await mkdir(custom, { recursive: true });
  try {
    await writeDataRootPointer(userData, custom);
    assert.equal(await resolveAppDataRoot(userData), custom);
    assert.equal(await readDataRootPointer(userData), custom);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('resolveAppDataRoot：指针损坏或目录缺失时回落默认并保留可用', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'reisa-datadir-'));
  try {
    await writeFile(join(userData, 'data-root.json'), '{broken json', 'utf8');
    assert.equal(await resolveAppDataRoot(userData), defaultAppDataRoot(userData));

    await writeDataRootPointer(userData, join(userData, 'missing-root'));
    assert.equal(await resolveAppDataRoot(userData), defaultAppDataRoot(userData));

    await clearDataRootPointer(userData);
    assert.equal(await readDataRootPointer(userData), undefined);
    assert.equal(await resolveAppDataRoot(userData), defaultAppDataRoot(userData));
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('validateMigrationTarget：相等、嵌套、缺失与非空目录均拒绝', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reisa-datadir-'));
  try {
    const source = join(base, 'source');
    const empty = join(base, 'empty');
    const occupied = join(base, 'occupied');
    const nested = join(source, 'inner');
    const outer = join(base, 'outer');
    const nestedSource = join(outer, 'app-data');
    await mkdir(source, { recursive: true });
    await mkdir(empty, { recursive: true });
    await mkdir(occupied, { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(nestedSource, { recursive: true });
    await writeFile(join(occupied, 'x.txt'), 'x', 'utf8');

    await assert.rejects(validateMigrationTarget(source, source), /相同/);
    await assert.rejects(validateMigrationTarget(source, nested), /内部/);
    // 目标（outer）包含源（outer/app-data）→ 拒绝
    await assert.rejects(validateMigrationTarget(nestedSource, outer), /包含/);
    await assert.rejects(validateMigrationTarget(source, join(base, 'no-such-dir')), /不存在/);
    await assert.rejects(validateMigrationTarget(source, occupied), /不是空目录/);
    await assert.doesNotReject(validateMigrationTarget(source, empty));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('validateMigrationTarget：恢复默认位置时非空默认目录给出含完整路径的专属文案', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reisa-datadir-'));
  try {
    const customRoot = join(base, 'custom');
    const defaultRoot = join(base, 'app-data');
    await mkdir(customRoot, { recursive: true });
    await mkdir(defaultRoot, { recursive: true });
    await writeFile(join(defaultRoot, 'stale.txt'), 'old backup', 'utf8');
    // 专属文案须包含默认目录完整路径（用户据此在文件管理器中定位并清空），行为保持手动清空
    await assert.rejects(
      validateMigrationTarget(customRoot, defaultRoot, { defaultRoot }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(defaultRoot), '错误信息应包含默认目录完整路径');
        assert.match(error.message, /数据备份/);
        return true;
      },
    );
    // 未声明 defaultRoot 时按通用文案拒绝（同样带路径）
    await assert.rejects(validateMigrationTarget(customRoot, defaultRoot), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /不是空目录/);
      assert.ok(error.message.includes(defaultRoot), '错误信息应包含目标目录路径');
      return true;
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('migrateAppData：全量复制并改写内嵌绝对路径，外部路径与源目录不动', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reisa-datadir-'));
  try {
    const sourceRoot = join(base, 'app-data');
    const targetRoot = join(base, 'elsewhere', 'app-data');
    await makeSourceAppData(sourceRoot);
    await mkdir(targetRoot, { recursive: true });

    const stats = await migrateAppData({ sourceRoot, targetRoot });

    // 文件清单与源完全一致，统计非零
    const sourceFiles = await listFiles(sourceRoot);
    assert.deepEqual(await listFiles(targetRoot), sourceFiles);
    assert.equal(stats.files, sourceFiles.length);
    assert.ok(stats.bytes > 0);

    // 会话附件路径已改写为新根
    const conversations = new DatabaseSync(join(targetRoot, 'main', 'conversations.sqlite'));
    const rows = conversations.prepare('SELECT id, path FROM attachments ORDER BY id').all();
    conversations.close();
    assert.deepEqual(
      rows.map((row) => row.id),
      ['att_1', 'att_external'],
    );
    assert.equal(
      rows.find((row) => row.id === 'att_1').path,
      join(targetRoot, 'main', 'attachments', 'conv_1', 'att_x-report.pdf'),
    );
    // 前缀不匹配的行原样保留
    assert.equal(
      rows.find((row) => row.id === 'att_external').path,
      join('D:\\elsewhere', 'x.png'),
    );

    // knowledge uploads 来源已改写为新根；外部来源不动
    const knowledge = new DatabaseSync(join(targetRoot, 'modules', 'knowledge', 'data.sqlite'));
    const sources = knowledge.prepare('SELECT id, path FROM sources ORDER BY id').all();
    knowledge.close();
    assert.equal(
      sources.find((row) => row.id === 'src_uploads').path,
      join(targetRoot, 'modules', 'knowledge', 'files', 'uploads'),
    );
    assert.equal(sources.find((row) => row.id === 'src_docs').path, 'D:\\docs');

    // 源目录内容保持原样（迁移为复制而非移动）
    const sourceConversations = new DatabaseSync(join(sourceRoot, 'main', 'conversations.sqlite'));
    const sourceRows = sourceConversations
      .prepare('SELECT path FROM attachments WHERE id = ?')
      .all('att_1');
    sourceConversations.close();
    assert.equal(
      sourceRows[0].path,
      join(sourceRoot, 'main', 'attachments', 'conv_1', 'att_x-report.pdf'),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('migrateAppData：复制/改写失败时清空目标目录回滚', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reisa-datadir-'));
  try {
    const sourceRoot = join(base, 'app-data');
    const targetRoot = join(base, 'target');
    await makeSourceAppData(sourceRoot, { corruptConversationsDb: true });
    await mkdir(targetRoot, { recursive: true });

    // 损坏的会话库在改写阶段打开失败 → 触发回滚：目标清空、错误上抛
    await assert.rejects(migrateAppData({ sourceRoot, targetRoot }));
    assert.equal((await readdir(targetRoot)).length, 0);
    // 源目录不受影响
    assert.ok((await listFiles(sourceRoot)).length > 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * Git 客户端与协调器单测（移植自 card_note test/sync_git_test.dart + sync_scheduler_test.dart）。
 * GitClient 用假 runner 验证命令序列与脱敏；协调器用真实 git（本地裸仓库）验证全流程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ModuleHost } from '@reisa/module-host';
import { CardNoteDatabase } from '../runtime/database.ts';
import { GitClient, GitException } from '../runtime/sync/git-client.ts';
import { SyncCoordinator, SyncScheduler } from '../runtime/sync/coordinator.ts';
import { createCardNoteRuntime } from '../runtime/index.ts';

class FakeRunner {
  #scripted = new Map();
  calls = [];
  script(command, result) {
    this.#scripted.set(command, result);
  }
  async run(arguments_, workingDirectory) {
    this.calls.push(arguments_.join(' '));
    const key = arguments_.join(' ');
    const result = this.#scripted.get(key);
    if (result !== undefined) return result;
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

const logger = { info: () => {}, error: () => {} };

test('GitClient（假 runner）：无变更时不提交；有变更时提交', async () => {
  const runner = new FakeRunner();
  const client = new GitClient({ runner, logger });
  runner.script('diff --cached --quiet', { exitCode: 0, stdout: '', stderr: '' });
  assert.equal(await client.stageAndCommit('dir', 'msg'), false);
  runner.script('diff --cached --quiet', { exitCode: 1, stdout: '', stderr: '' });
  assert.equal(await client.stageAndCommit('dir', 'msg'), true);
  assert.deepEqual(runner.calls, [
    'add --all',
    'diff --cached --quiet',
    'add --all',
    'diff --cached --quiet',
    'commit --message msg',
  ]);
});

test('GitClient（假 runner）：ls-remote 退出码 2 = 远端无 main；错误信息脱敏 URL 凭据', async () => {
  const runner = new FakeRunner();
  const client = new GitClient({ runner, logger });
  runner.script('ls-remote --exit-code --heads origin main', { exitCode: 2, stdout: '', stderr: '' });
  assert.equal(await client.remoteMainExists('dir'), false);
  runner.script('ls-remote --exit-code --heads origin main', {
    exitCode: 128,
    stdout: '',
    stderr: 'fatal: unable to access https://user:token@example.com/repo.git/',
  });
  await assert.rejects(() => client.remoteMainExists('dir'), (error) => {
    assert.ok(error instanceof GitException);
    assert.match(error.message, /https:\/\/\*\*\*@example\.com/);
    assert.doesNotMatch(error.message, /token/);
    return true;
  });
});

/** 测试用内存配置（与 module-host 缺省 config 同语义）。 */
class MemoryConfig {
  #values = new Map();
  async get(key) {
    return this.#values.get(key);
  }
  async set(key, value) {
    this.#values.set(key, value);
  }
}

test('调度器：未配置/无变更不触发同步；有变更且启用时触发一次', async () => {
  const database = new CardNoteDatabase(':memory:');
  const config = new MemoryConfig();
  let syncCalls = 0;
  const scheduler = new SyncScheduler({
    database,
    config,
    synchronize: async () => {
      syncCalls += 1;
    },
    logger,
  });

  await scheduler.runIfNeeded();
  assert.equal(syncCalls, 0); // 未配置

  await config.set('sync.auto_sync', true);
  await config.set('sync.workspace_path', join(tmpdir(), 'card-note-ws'));
  await config.set('sync.interval_minutes', 10);
  await scheduler.runIfNeeded();
  assert.equal(syncCalls, 0); // 已配置但 outbox 为空

  database.createBook('有变更的书');
  await scheduler.runIfNeeded();
  assert.equal(syncCalls, 1); // 配置 + 存在本地变更 → 触发

  scheduler.dispose();
  database.close();
});

test('协调器（真实 git）：初始化 → 变更同步推送；另一设备克隆导入；导入前产生备份', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'card-note-git-'));
  let hostA;
  let hostB;
  try {
    const remote = join(temporary, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);

    // 设备 A：通过真实 ModuleHost 装配（与生产同路径），初始化 + 编辑 + 同步
    const rootA = join(temporary, 'device-a');
    hostA = new ModuleHost({ storageRoot: rootA });
    let pageServiceA;
    hostA.register(
      createCardNoteRuntime({
        registerPageService: (invoke) => {
          pageServiceA = invoke;
        },
      }),
    );
    await hostA.activate('card-note');
    const bookA = await pageServiceA('create_book', { title: '同步书' });
    await pageServiceA('save_note', { bookId: bookA.id, quote: '跨设备正文', comment: null });

    const settingsA = await pageServiceA('get_sync_status', {});
    assert.equal(settingsA.gitAvailable, true, '测试环境必须可用 git');
    assert.equal(settingsA.pendingChanges, 2);
    await pageServiceA('initialize_sync_workspace', {
      workspacePath: join(temporary, 'workspace-a'),
      remoteUrl: remote,
    });
    // 初始化走全量快照，不确认 outbox（与源一致）：待同步变更保留，下次同步重导同内容为空操作
    const afterInit = await pageServiceA('get_sync_status', {});
    assert.equal(afterInit.pendingChanges, 2);

    await pageServiceA('save_note', { bookId: bookA.id, quote: '初始化后的新笔记', comment: null });
    const run = await pageServiceA('sync_now', {});
    assert.equal(run.exportedDocuments, 3); // book + 2 notes（含初始化遗留的同内容变更）
    assert.equal(run.createdCommit, true);
    const afterSync = await pageServiceA('get_sync_status', {});
    assert.equal(afterSync.pendingChanges, 0);

    // 设备 B：克隆导入，数据一致；导入前备份存在
    const rootB = join(temporary, 'device-b');
    hostB = new ModuleHost({ storageRoot: rootB });
    let pageServiceB;
    hostB.register(
      createCardNoteRuntime({
        registerPageService: (invoke) => {
          pageServiceB = invoke;
        },
      }),
    );
    await hostB.activate('card-note');
    const imported = await pageServiceB('clone_sync_repository', {
      workspacePath: join(temporary, 'workspace-b'),
      remoteUrl: remote,
    });
    assert.ok(imported.importedDocuments >= 3);
    const booksB = await pageServiceB('list_books', {});
    assert.equal(booksB.length, 1);
    assert.equal(booksB[0].title, '同步书');
    const notesB = await pageServiceB('list_notes', { bookId: booksB[0].id });
    assert.equal(notesB.length, 2);
    // UUID 与设备 A 一致（M6 兼容的关键前提）
    const booksA = await pageServiceA('list_books', {});
    assert.equal(booksA[0].id, booksB[0].id);
    // D3：导入前备份
    assert.ok(existsSync(join(rootB, 'card-note', 'card-note.sqlite.bak')));

    // 设备 A 再次同步：拉取 B 无新变更 → 空操作成功
    const run2 = await pageServiceA('sync_now', {});
    assert.equal(run2.exportedDocuments, 0);
  } finally {
    await hostA?.deactivate('card-note').catch(() => {});
    await hostB?.deactivate('card-note').catch(() => {});
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

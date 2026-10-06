/**
 * 运行时端到端测试：真实 ModuleHost 装配待办模块，验证
 * 生命周期（激活/停用/数据保留）、能力注册（5 个工具，R3）与页面服务通道全链路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleHost } from '@reisa/module-host';
import { createTodoRuntime } from '../runtime/index.ts';

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), 'todo-runtime-'));
  const host = new ModuleHost({ storageRoot: root });
  let pageService;
  const runtime = createTodoRuntime({
    registerPageService: (invoke) => {
      pageService = invoke;
    },
  });
  host.register(runtime);
  await host.activate('todo');
  return {
    host,
    pageService,
    storageRoot: root,
    cleanup: async () => {
      await host.deactivate('todo').catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('激活后模块 active，注册 5 个能力（todo__* 命名，R3/附录 B）', async () => {
  const { host, cleanup } = await makeHost();
  try {
    assert.equal(host.getState('todo'), 'active');
    const capabilities = host.listEnabledCapabilities();
    assert.deepEqual(capabilities.map((capability) => capability.name).sort(), [
      'todo__get_todo',
      'todo__list_categories',
      'todo__list_progress',
      'todo__list_todos',
      'todo__update_todo_status',
    ]);
  } finally {
    await cleanup();
  }
});

test('页面服务：分类 → 待办 → 进度 全链路（保存/切换状态/校验消息/级联）', async () => {
  const { pageService, cleanup } = await makeHost();
  try {
    // 分类
    const category = await pageService('save_category', { name: '  工作  ' });
    assert.equal(typeof category.id, 'number');
    const categories = await pageService('list_categories', { searchKey: '工' });
    assert.equal(categories.items.length, 1);
    assert.equal(categories.items[0].name, '工作');

    // 新建待办：固定未开始（§5.2）
    const saved = await pageService('save_todo', {
      title: '  写迁移文档  ',
      detail: '含验收标准',
      categoryId: category.id,
      deadlineTime: null,
    });
    assert.equal(typeof saved.id, 'number');

    const todo = await pageService('get_todo', { id: saved.id });
    assert.equal(todo.title, '写迁移文档');
    assert.equal(todo.status, 0);
    assert.equal(todo.statusText, '未开始');
    assert.equal(todo.categoryName, '工作');

    // 编辑：改状态 + 截止时间
    await pageService('save_todo', {
      todoId: saved.id,
      title: '写迁移文档',
      detail: null,
      status: 3,
      categoryId: category.id,
      deadlineTime: Date.now() + 86_400_000,
    });
    const edited = await pageService('get_todo', { id: saved.id });
    assert.equal(edited.status, 3);
    assert.equal(edited.statusText, '已超时');
    assert.equal(edited.deadlineTime !== null, true);

    // 状态切换（源 _switchStatus：已完成 → 未开始）
    const toggled = await pageService('update_todo_status', { id: saved.id, status: 2 });
    assert.equal(toggled.status, 2);
    assert.equal(toggled.statusText, '已完成');

    // 列表过滤
    await pageService('save_todo', { title: '买菜', categoryId: null });
    const filtered = await pageService('list_todos', { status: 2 });
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].title, '写迁移文档');
    assert.equal(filtered.hasMore, false, 'R6①：不足一页时 hasMore=false');

    // 进度
    const progress = await pageService('add_progress', { todoId: saved.id, content: ' 初稿完成 ' });
    assert.equal(typeof progress.id, 'number');
    await assert.rejects(
      () => pageService('add_progress', { todoId: saved.id, content: '   ' }),
      /内容不得为空/,
    );
    await assert.rejects(
      () => pageService('save_todo', { title: '   ', categoryId: null }),
      /标题不得为空/,
    );
    await pageService('update_progress_finished', { id: progress.id, isFinished: true });
    const progressList = await pageService('list_progress', { todoId: saved.id });
    assert.equal(progressList.items[0].isFinished, true);

    // 删除待办级联清进度（R6②）
    await pageService('delete_todo', { id: saved.id });
    assert.equal(await pageService('get_todo', { id: saved.id }), null);
    const emptied = await pageService('list_progress', { todoId: saved.id });
    assert.deepEqual(emptied.items, []);
  } finally {
    await cleanup();
  }
});

test('页面服务：未知动作与无效 ID 报错', async () => {
  const { pageService, cleanup } = await makeHost();
  try {
    await assert.rejects(() => pageService('nope', {}), /未知的页面服务操作/);
    await assert.rejects(() => pageService('get_todo', { id: 0 }), /ID 无效/);
  } finally {
    await cleanup();
  }
});

test('停用后拒绝调用；重新激活数据保留（宿主停用不删业务数据，架构设计 §10.1）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'todo-runtime-persist-'));
  const host = new ModuleHost({ storageRoot: root });
  const invokers = [];
  const runtime = createTodoRuntime({
    registerPageService: (invoke) => {
      invokers.push(invoke);
    },
  });
  host.register(runtime);
  try {
    await host.activate('todo');
    const pageService = invokers.at(-1);
    await pageService('save_todo', { title: '停用前的待办' });

    await host.deactivate('todo');
    await assert.rejects(() => pageService('list_todos', {}), /未激活/);

    await host.activate('todo');
    const revived = await invokers.at(-1)('list_todos', {});
    assert.equal(revived.items.length, 1);
    assert.equal(revived.items[0].title, '停用前的待办');
  } finally {
    await host.deactivate('todo').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

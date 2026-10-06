/**
 * 能力层测试（附录 B）：经宿主 invoke 走完整校验链（TypeBox 输入校验 → 处理器 → 输出校验），
 * 断言清单对齐源 test/todo_mcp_server_test.dart 的工具行为用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleHost } from '@reisa/module-host';
import { createTodoRuntime } from '../runtime/index.ts';

const CONTEXT = { invocationId: 'test-invocation', signal: new AbortController().signal };

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), 'todo-capabilities-'));
  const host = new ModuleHost({ storageRoot: root });
  const invokers = [];
  const runtime = createTodoRuntime({
    registerPageService: (invoke) => {
      invokers.push(invoke);
    },
  });
  host.register(runtime);
  await host.activate('todo');
  const pageService = invokers.at(-1);
  // 成功路径助手：解包 ToolResult 信封，失败即断言失败（正常路径只关心 value）。
  const invoke = async (capabilityId, input) => {
    const result = await host.invoke(capabilityId, input, CONTEXT);
    assert.equal(result.status, 'success', result.status === 'error' ? result.error.message : '');
    return result.value;
  };
  // 失败路径助手：保留完整 ToolResult 结构（错误码断言用）。
  const rawInvoke = (capabilityId, input) => host.invoke(capabilityId, input, CONTEXT);
  return {
    host,
    pageService,
    invoke,
    rawInvoke,
    cleanup: async () => {
      await host.deactivate('todo').catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('list_todos：分页结构 {items,page,pageSize,hasMore}，时间为 UTC ISO，含 statusText/categoryName', async () => {
  const { pageService, invoke, cleanup } = await makeHost();
  try {
    const category = await pageService('save_category', { name: '工作' });
    await pageService('save_todo', {
      title: 'ISO 时间检查',
      detail: '详情',
      categoryId: category.id,
      deadlineTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });

    const result = await invoke('todo/list_todos', { page: 1, pageSize: 20 });
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 20);
    assert.equal(result.hasMore, false);
    assert.equal(result.items.length, 1);
    const todo = result.items[0];
    assert.equal(todo.title, 'ISO 时间检查');
    assert.equal(todo.status, 0);
    assert.equal(todo.statusText, '未开始');
    assert.equal(todo.categoryName, '工作');
    assert.equal(todo.createTime, new Date(todo.createTime).toISOString());
    assert.equal(todo.deadlineTime, '2026-01-02T03:04:05.000Z');
  } finally {
    await cleanup();
  }
});

test('list_todos：过滤参数（searchKey/status/categoryId）与默认分页', async () => {
  const { pageService, invoke, rawInvoke, cleanup } = await makeHost();
  try {
    await pageService('save_todo', { title: '完成的事' });
    const created = await pageService('save_todo', { title: '未完成的事' });
    await pageService('update_todo_status', { id: created.id, status: 0 });

    const bySearch = await invoke('todo/list_todos', { searchKey: '未完成' });
    assert.equal(bySearch.items.length, 1);
    assert.equal(bySearch.items[0].title, '未完成的事');

    const byStatus = await invoke('todo/list_todos', { status: 0 });
    assert.equal(byStatus.items.length, 2, '两条都是未开始');

    const badStatus = await rawInvoke('todo/list_todos', { status: 9 });
    assert.equal(badStatus.status, 'error', 'schema 外的状态应被输入校验拒绝');
    assert.equal(badStatus.error.code, 'INVALID_INPUT');
  } finally {
    await cleanup();
  }
});

test('get_todo：存在返回详情；不存在返回 {todo: null}（源 MCP 语义）', async () => {
  const { pageService, invoke, cleanup } = await makeHost();
  try {
    const saved = await pageService('save_todo', { title: '单条查询' });
    const found = await invoke('todo/get_todo', { id: saved.id });
    assert.equal(found.todo.title, '单条查询');
    const missing = await invoke('todo/get_todo', { id: 424242 });
    assert.equal(missing.todo, null);
  } finally {
    await cleanup();
  }
});

test('update_todo_status：更新后回读；id 不存在返回 {todo: null}（源 MCP 语义）', async () => {
  const { pageService, invoke, cleanup } = await makeHost();
  try {
    const saved = await pageService('save_todo', { title: '要完成的任务' });
    const updated = await invoke('todo/update_todo_status', { id: saved.id, status: 2 });
    assert.equal(updated.todo.status, 2);
    assert.equal(updated.todo.statusText, '已完成');

    const missing = await invoke('todo/update_todo_status', { id: 424242, status: 1 });
    assert.equal(missing.todo, null);
  } finally {
    await cleanup();
  }
});

test('list_categories / list_progress：分页与未完成在前的排序', async () => {
  const { pageService, invoke, rawInvoke, cleanup } = await makeHost();
  try {
    const saved = await pageService('save_todo', { title: '有进度的任务' });
    const p1 = await pageService('add_progress', { todoId: saved.id, content: '第一条' });
    await pageService('add_progress', { todoId: saved.id, content: '第二条' });
    await pageService('update_progress_finished', { id: p1.id, isFinished: true });

    const categories = await invoke('todo/list_categories', { searchKey: '不存在的分类' });
    assert.equal(categories.items.length, 0);

    const progress = await invoke('todo/list_progress', { todoId: saved.id });
    assert.equal(progress.items.length, 2);
    assert.equal(progress.items[0].content, '第二条', '未完成在前');
    assert.equal(progress.items[1].content, '第一条');
    assert.equal(typeof progress.items[0].isFinished, 'boolean');

    const badInput = await rawInvoke('todo/list_progress', { todoId: 0 });
    assert.equal(badInput.status, 'error', 'todoId 违反 minimum:1 应被输入校验拒绝');
  } finally {
    await cleanup();
  }
});

test('能力输入经宿主 Schema 校验：非法输入返回 INVALID_INPUT 结构化失败', async () => {
  const { rawInvoke, cleanup } = await makeHost();
  try {
    const failure = await rawInvoke('todo/list_todos', { pageSize: 1000 });
    assert.equal(failure.status, 'error');
    assert.equal(failure.error.code, 'INVALID_INPUT');
    assert.equal(failure.error.invocationId, 'test-invocation');
  } finally {
    await cleanup();
  }
});

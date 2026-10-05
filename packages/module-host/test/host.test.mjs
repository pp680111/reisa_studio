/**
 * module-host 行为测试：生命周期状态机、能力注册校验、invoke 校验与取消、全量能力列表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { toolSuccess } from '@reisa/module-sdk';
import { ModuleHost } from '../src/index.ts';

function makeTool(id, action, inputSchema, execute, outputSchema) {
  return {
    definition: {
      id,
      name: `${id.split('/')[0]}__${action}`,
      version: '0.1.0',
      description: `${id} 测试能力`,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
    },
    execute,
  };
}

function makeModule(id, { tools = [], onActivate, onDeactivate, protocolVersion = '1' } = {}) {
  return {
    id,
    version: '0.1.0',
    protocolVersion,
    async activate(context) {
      onActivate?.(context);
      return { tools, deactivate: async () => onDeactivate?.() };
    },
  };
}

const invocation = (invocationId) => ({ invocationId, signal: new AbortController().signal });

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), 'reisa-host-'));
  return new ModuleHost({ storageRoot: root });
}

test('激活后调用：输入校验通过、处理器收到上下文、结果返回', async () => {
  const host = await makeHost();
  const seen = {};
  const double = makeTool(
    'math/double',
    'double',
    Type.Object({ n: Type.Number() }),
    async (input, context) => {
      seen.invocationId = context.invocationId;
      seen.signal = context.signal;
      return toolSuccess({ result: input.n * 2 });
    },
  );
  host.register(makeModule('math', { tools: [double] }));
  await host.activate('math');

  assert.equal(host.getState('math'), 'active');
  assert.deepEqual(
    host.listEnabledCapabilities().map((c) => c.id),
    ['math/double'],
  );

  const result = await host.invoke('math/double', { n: 4 }, invocation('inv-1'));
  assert.deepEqual(result, { status: 'success', value: { result: 8 } });
  assert.equal(seen.invocationId, 'inv-1', '调用 ID 全程透传');
  assert.ok(seen.signal instanceof AbortSignal, '处理器必须收到取消信号');
});

test('输入不符声明：INVALID_INPUT，处理器不被调用', async () => {
  const host = await makeHost();
  let called = false;
  const tool = makeTool('math/double', 'double', Type.Object({ n: Type.Number() }), async () => {
    called = true;
    return toolSuccess({});
  });
  host.register(makeModule('math', { tools: [tool] }));
  await host.activate('math');

  const result = await host.invoke('math/double', { n: '不是数字' }, invocation('inv-2'));
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'INVALID_INPUT');
  assert.equal(result.error?.invocationId, 'inv-2');
  assert.ok(result.error?.details?.length > 0, '错误应携带校验细节');
  assert.equal(called, false);
});

test('未知能力与未激活模块：CAPABILITY_UNAVAILABLE', async () => {
  const host = await makeHost();
  host.register(
    makeModule('math', {
      tools: [makeTool('math/one', 'one', Type.Object({}), async () => toolSuccess(null))],
    }),
  );

  const unknown = await host.invoke('math/one', {}, invocation('inv-3'));
  assert.equal(unknown.error?.code, 'CAPABILITY_UNAVAILABLE', '未激活模块的能力不可用');

  const missing = await host.invoke('nope/action', {}, invocation('inv-4'));
  assert.equal(missing.error?.code, 'CAPABILITY_UNAVAILABLE');
});

test('处理器抛错：统一为 EXECUTION_FAILED', async () => {
  const host = await makeHost();
  const boom = makeTool('math/boom', 'boom', Type.Object({}), async () => {
    throw new Error('内部原因不外泄');
  });
  host.register(makeModule('math', { tools: [boom] }));
  await host.activate('math');

  const result = await host.invoke('math/boom', {}, invocation('inv-5'));
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'EXECUTION_FAILED');
  assert.equal(host.getState('math'), 'active', '单次工具失败不使模块 failed（§10.1）');
  assert.ok(host.listEnabledCapabilities().length === 1, '失败后注册保持不变');
});

test('处理器抛错：公开文案稳定化，原始错误仅进宿主日志（架构 §10.3）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reisa-host-'));
  const errorLogs = [];
  const host = new ModuleHost({
    storageRoot: root,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => errorLogs.push(message),
    },
  });
  const boom = makeTool('math/boom', 'boom', Type.Object({}), async () => {
    throw new Error("ENOENT: no such file or directory, open 'C:\\Users\\z\\secret.md'");
  });
  host.register(makeModule('math', { tools: [boom] }));
  await host.activate('math');

  const result = await host.invoke('math/boom', {}, invocation('inv-secret'));
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'EXECUTION_FAILED');
  assert.equal(result.error?.invocationId, 'inv-secret', '调用 ID 保留');
  // 公开文案稳定：不含内部细节（盘符、目录、原始错误类别）
  assert.equal(result.error?.message, '模块能力执行失败');
  assert.ok(result.error?.details === undefined, '失败不携带内部细节');
  // 完整原始错误留在宿主运行层日志
  assert.equal(errorLogs.length, 1);
  assert.match(errorLogs[0], /math\/boom/);
  assert.match(errorLogs[0], /ENOENT/);
  assert.match(errorLogs[0], /secret\.md/, '日志侧保留完整原始错误供诊断');
  assert.equal(host.getState('math'), 'active', '公开错误稳定化不改变单次失败语义');
  await host.deactivate('math');
});

test('停用顺序：拒绝新调用 → 撤销注册 → 取消在途 → 等待结束 → 清理 → disabled', async () => {
  const host = await makeHost();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let capturedSignal;
  let deactivated = false;
  const slow = makeTool('slow/work', 'work', Type.Object({}), async (_input, context) => {
    capturedSignal = context.signal;
    await gate;
    return toolSuccess({ done: true });
  });
  host.register(makeModule('slow', { tools: [slow], onDeactivate: () => (deactivated = true) }));
  await host.activate('slow');

  const inFlight = host.invoke('slow/work', {}, invocation('inv-6'));
  const deactivating = host.deactivate('slow');

  const rejected = await host.invoke('slow/work', {}, invocation('inv-7'));
  assert.equal(rejected.error?.code, 'CAPABILITY_UNAVAILABLE', 'deactivating 状态拒绝新调用');

  // 处理器未结束：模块停留在 deactivating，activation 清理不执行（清理时序回归断言）
  assert.equal(host.getState('slow'), 'deactivating');
  assert.equal(deactivated, false, '处理器结束前不执行 activation 清理');
  let deactivateSettled = false;
  deactivating.then(
    () => {
      deactivateSettled = true;
    },
    () => {
      deactivateSettled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deactivateSettled, false, '在途处理器结束前停用不完成');

  release();
  const result = await inFlight;
  await deactivating;

  assert.equal(host.getState('slow'), 'disabled');
  assert.equal(deactivated, true, '等待处理器结束后执行 deactivate');
  assert.equal(capturedSignal.aborted, true, '执行中请求收到取消信号');
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'CANCELLED', '被取消的调用返回结构化取消错误，不伪装成功');
  assert.ok(host.listEnabledCapabilities().length === 0, '注册已撤销');
});

test('已中止的调用：CANCELLED 且处理器不执行（无副作用）', async () => {
  const host = await makeHost();
  let executed = false;
  const tool = makeTool('math/noop', 'noop', Type.Object({}), async () => {
    executed = true;
    return toolSuccess({ touched: true });
  });
  host.register(makeModule('math', { tools: [tool] }));
  await host.activate('math');

  const controller = new AbortController();
  controller.abort();
  const result = await host.invoke(
    'math/noop',
    {},
    {
      invocationId: 'inv-aborted',
      signal: controller.signal,
    },
  );
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'CANCELLED');
  assert.equal(executed, false, '已中止的调用不进入处理器，副作用未发生');
});

test('页面调用纳入停用跟踪：在途页面调用阻止停用完成，并收到停用取消信号', async () => {
  const host = await makeHost();
  host.register(makeModule('slow', {}));
  await host.activate('slow');

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let pageSignal;
  const page = host.runTracked('slow', async (signal) => {
    pageSignal = signal;
    await gate;
    return '页面结果';
  });

  await assert.rejects(() => host.runTracked('missing', async () => 'x'), /未激活/);

  const deactivating = host.deactivate('slow');
  await assert.rejects(
    () => host.runTracked('slow', async () => 'y'),
    /未激活/,
    'deactivating 状态拒绝新页面调用',
  );

  // 页面调用未结束：停用保持在 deactivating（页面调用纳入同一等待语义）
  let deactivateSettled = false;
  deactivating.then(
    () => {
      deactivateSettled = true;
    },
    () => {
      deactivateSettled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deactivateSettled, false, '在途页面调用未结束时停用不完成');
  assert.equal(host.getState('slow'), 'deactivating');

  release();
  assert.equal(await page, '页面结果');
  await deactivating;
  assert.equal(host.getState('slow'), 'disabled');
  assert.equal(pageSignal.aborted, true, '页面调用持有与模块停用关联的取消信号');
});

test('激活失败：模块进入 failed，无任何能力注册', async () => {
  const host = await makeHost();
  host.register(
    makeModule('broken', {
      onActivate: () => {
        throw new Error('基础设施不可用');
      },
    }),
  );
  await assert.rejects(() => host.activate('broken'));
  assert.equal(host.getState('broken'), 'failed');
  assert.match(host.getStatus('broken')?.error ?? '', /基础设施不可用/);
  assert.ok(host.listEnabledCapabilities().length === 0);
});

test('注册校验：命名空间、工具名与处理器必须合规', async () => {
  const host = await makeHost();
  const bad = {
    definition: {
      id: 'elsewhere/action',
      name: 'elsewhere__action',
      version: '0.1.0',
      description: '越界能力',
      inputSchema: Type.Object({}),
    },
    execute: async () => toolSuccess(null),
  };
  host.register(makeModule('math', { tools: [bad] }));
  await assert.rejects(() => host.activate('math'), /命名空间/);
  assert.equal(host.getState('math'), 'failed');
  assert.ok(host.listEnabledCapabilities().length === 0, '校验失败整体撤销，不产生部分注册');
});

test('协议版本不符：激活失败', async () => {
  const host = await makeHost();
  host.register(makeModule('legacy', { protocolVersion: '0' }));
  await assert.rejects(() => host.activate('legacy'), /协议版本/);
  assert.equal(host.getState('legacy'), 'failed');
});

test('注册校验失败回滚：已取得的 activation 被停用，注册表无残留', async () => {
  const host = await makeHost();
  let deactivateCalls = 0;
  // activate 成功返回后注册了无效工具名（不符合 moduleId__action 格式）的 activation
  const bad = {
    definition: {
      id: 'math/bad',
      name: 'wrong__name',
      version: '0.1.0',
      description: '工具名不合规的能力',
      inputSchema: Type.Object({}),
    },
    execute: async () => toolSuccess(null),
  };
  host.register(makeModule('math', { tools: [bad], onDeactivate: () => (deactivateCalls += 1) }));
  await assert.rejects(() => host.activate('math'), /能力注册无效/);
  assert.equal(deactivateCalls, 1, '激活失败分支必须回滚调用 activation.deactivate');
  assert.equal(host.getState('math'), 'failed');
  assert.match(host.getStatus('math')?.error ?? '', /能力注册无效/);
  assert.ok(host.listEnabledCapabilities().length === 0, '注册表无该模块条目');
});

test('activation 之前的失败（协议版本不匹配）不调用 deactivate', async () => {
  const host = await makeHost();
  let deactivateCalls = 0;
  host.register(
    makeModule('legacy', { protocolVersion: '0', onDeactivate: () => (deactivateCalls += 1) }),
  );
  await assert.rejects(() => host.activate('legacy'), /协议版本/);
  assert.equal(deactivateCalls, 0, '无 activation 可回滚时不调用 deactivate');
  assert.equal(host.getState('legacy'), 'failed');
});

test('回滚时 deactivate 抛错：原始激活错误仍抛出，次要错误不吞主错误', async () => {
  const host = await makeHost();
  // 注册校验失败（工具名不合规）触发回滚，且回滚的 deactivate 自身也抛错
  const bad = {
    definition: {
      id: 'math/bad',
      name: 'wrong__name',
      version: '0.1.0',
      description: '工具名不合规的能力',
      inputSchema: Type.Object({}),
    },
    execute: async () => toolSuccess(null),
  };
  host.register({
    id: 'math',
    version: '0.1.0',
    protocolVersion: '1',
    async activate() {
      return {
        tools: [bad],
        deactivate: async () => {
          throw new Error('回滚清理也失败');
        },
      };
    },
  });
  await assert.rejects(() => host.activate('math'), /能力注册无效/);
  const status = host.getStatus('math');
  assert.equal(status?.state, 'failed');
  assert.match(status?.error ?? '', /能力注册无效/, '记录的错误保留原始失败原因');
  assert.match(status?.error ?? '', /回滚清理也失败/, '次要错误被记录但不替换主错误');
});

test('全量提供：停用模块后能力集合随之收缩，不做筛选', async () => {
  const host = await makeHost();
  host.register(
    makeModule('a', {
      tools: [makeTool('a/one', 'one', Type.Object({}), async () => toolSuccess(null))],
    }),
  );
  host.register(
    makeModule('b', {
      tools: [makeTool('b/two', 'two', Type.Object({}), async () => toolSuccess(null))],
    }),
  );
  await host.activate('a');
  await host.activate('b');
  assert.deepEqual(
    host
      .listEnabledCapabilities()
      .map((c) => c.id)
      .sort(),
    ['a/one', 'b/two'],
  );

  await host.deactivate('b');
  assert.deepEqual(
    host.listEnabledCapabilities().map((c) => c.id),
    ['a/one'],
  );
  assert.equal(host.getState('b'), 'disabled', '停用不删除模块登记，可重新激活');
});

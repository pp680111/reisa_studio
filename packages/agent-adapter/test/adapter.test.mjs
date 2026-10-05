/**
 * agent-adapter 行为测试：基于 Mock 模型（无网络），验证
 * startConversation / cancelConversation / toFrameworkTool / toConversationEvent 四个概念操作。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startConversation, toFrameworkTools } from '../src/index.ts';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

const usage = {
  inputTokens: { total: 5, noCache: 5 },
  outputTokens: { total: 5, noCache: 5 },
};

function definition(id, name, description) {
  return {
    id,
    name,
    version: '0.1.0',
    description,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  };
}

const DEFINITIONS = [
  definition('knowledge/search', 'knowledge__search', '检索知识库片段'),
  definition('knowledge/read_document', 'knowledge__read_document', '读取文档'),
  definition('knowledge/list_documents', 'knowledge__list_documents', '列出文档'),
];

function successRegistrar(record, value = { answer: 42 }) {
  return async (capabilityId, input, context) => {
    record.calls.push({
      capabilityId,
      input,
      invocationId: context.invocationId,
      signal: context.signal,
    });
    return { status: 'success', value };
  };
}

function toolCallStep(index, toolName, query = '产品 A') {
  const id = `tc-${index}`;
  const input = JSON.stringify({ query });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: input },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input },
    { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: undefined } },
  ];
}

function textStep(index, text) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: `t-${index}` },
    { type: 'text-delta', id: `t-${index}`, delta: text },
    { type: 'text-end', id: `t-${index}` },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
  ];
}

/** 未完成任何步骤的流中途错误：错误部件后流终止。 */
function interruptedTextStep(index, text) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: `t-${index}` },
    { type: 'text-delta', id: `t-${index}`, delta: text },
    { type: 'text-end', id: `t-${index}` },
    { type: 'error', error: new Error('模拟模型流中断') },
  ];
}

/** 模型以 error 结束原因收尾（步骤已完成，无错误部件）。 */
function errorFinishStep(index, text) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: `t-${index}` },
    { type: 'text-delta', id: `t-${index}`, delta: text },
    { type: 'text-end', id: `t-${index}` },
    { type: 'finish', usage, finishReason: { unified: 'error', raw: undefined } },
  ];
}

function scriptedModel(steps) {
  let call = 0;
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doStream: () => {
      const chunks = steps[Math.min(call, steps.length - 1)];
      call += 1;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

async function collectEvents(session) {
  const events = [];
  for await (const event of session.events) events.push(event);
  return events;
}

test('文本会话：text-delta 与 finish(stop)，产出消息可持久化', async () => {
  const record = { calls: [] };
  const model = scriptedModel([textStep(1, '你好，世界。')]);
  const session = startConversation({
    model,
    messages: [{ role: 'user', content: '打个招呼' }],
    capabilities: DEFINITIONS,
    invoker: successRegistrar(record),
  });

  const events = await collectEvents(session);
  assert.deepEqual(events, [
    { type: 'text-delta', text: '你好，世界。' },
    { type: 'finish', reason: 'stop' },
  ]);

  const outcome = await session.outcome;
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.finishReason, 'stop');
  assert.deepEqual(
    outcome.messages.map((m) => m.role),
    ['assistant'],
  );
  assert.equal(record.calls.length, 0, '纯文本会话不应调用能力入口');
});

test('工具会话：能力调用入口收到 ID/输入/上下文，事件携带解包后的结果', async () => {
  const record = { calls: [] };
  const model = scriptedModel([toolCallStep(1, 'knowledge__search'), textStep(2, '检索完成。')]);
  const session = startConversation({
    model,
    messages: [{ role: 'user', content: '检索产品 A' }],
    capabilities: DEFINITIONS,
    invoker: successRegistrar(record),
  });

  const events = await collectEvents(session);
  const toolCall = events.find((e) => e.type === 'tool-call');
  const toolResult = events.find((e) => e.type === 'tool-result');
  const finish = events.find((e) => e.type === 'finish');

  assert.deepEqual(toolCall, {
    type: 'tool-call',
    toolCallId: 'tc-1',
    toolName: 'knowledge__search',
    input: { query: '产品 A' },
  });
  assert.deepEqual(toolResult, {
    type: 'tool-result',
    toolCallId: 'tc-1',
    toolName: 'knowledge__search',
    output: { answer: 42 },
  });
  assert.deepEqual(finish, { type: 'finish', reason: 'stop' });

  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].capabilityId, 'knowledge/search', '调用入口收到命名空间能力 ID');
  assert.deepEqual(record.calls[0].input, { query: '产品 A' });
  assert.equal(typeof record.calls[0].invocationId, 'string');
  assert.ok(record.calls[0].invocationId.length > 0);
  assert.ok(record.calls[0].signal instanceof AbortSignal, '上下文必须携带取消信号');

  const outcome = await session.outcome;
  assert.equal(outcome.status, 'completed');
  const messages = outcome.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const call = messages.find((p) => p.type === 'tool-call');
  const result = messages.find((p) => p.type === 'tool-result');
  assert.equal(call?.toolCallId, 'tc-1');
  assert.equal(result?.toolCallId, 'tc-1', '持久化消息中调用与结果 ID 对应');
});

test('能力失败：tool-error 事件携带公开错误负载，会话继续到自然结束', async () => {
  const payload = {
    code: 'RESOURCE_NOT_FOUND',
    message: '文档不存在',
    invocationId: 'inv-1',
    retryable: false,
  };
  const invoker = async () => ({ status: 'error', error: payload });
  const model = scriptedModel([
    toolCallStep(1, 'knowledge__read_document'),
    textStep(2, '该文档不可用。'),
  ]);
  const session = startConversation({
    model,
    messages: [{ role: 'user', content: '读一下文档' }],
    capabilities: DEFINITIONS,
    invoker,
  });

  const events = await collectEvents(session);
  const toolError = events.find((e) => e.type === 'tool-error');
  assert.deepEqual(toolError, {
    type: 'tool-error',
    toolCallId: 'tc-1',
    toolName: 'knowledge__read_document',
    error: payload,
  });

  const outcome = await session.outcome;
  assert.equal(outcome.status, 'completed', '单次能力失败不终止会话');
  assert.equal(outcome.finishReason, 'stop');
});

test('模型流中断：outcome 为失败并携带公开错误信息，不得误判为完成', async () => {
  const model = scriptedModel([interruptedTextStep(1, '回答进行到一半')]);
  const session = startConversation({
    model,
    messages: [{ role: 'user', content: '继续回答' }],
    capabilities: DEFINITIONS,
    invoker: successRegistrar({ calls: [] }),
  });

  const events = await collectEvents(session);
  assert.ok(
    events.some((e) => e.type === 'error' && e.message === '模拟模型流中断'),
    '事件流应携带错误事件',
  );

  const outcome = await session.outcome;
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.error, '模拟模型流中断', 'outcome 应带出流中的公开错误信息');
  assert.notEqual(outcome.status, 'completed');
});

test('finishReason 为 error：即使 steps 正常 resolve，outcome 也是失败状态', async () => {
  const model = scriptedModel([errorFinishStep(1, '部分回答')]);
  const session = startConversation({
    model,
    messages: [{ role: 'user', content: '继续回答' }],
    capabilities: DEFINITIONS,
    invoker: successRegistrar({ calls: [] }),
  });

  const outcome = await session.outcome;
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.finishReason, 'error');
  assert.equal(typeof outcome.error, 'string');
  assert.ok(outcome.error.length > 0, '失败 outcome 应携带可展示的错误文案');
  const roles = outcome.messages.map((m) => m.role);
  assert.ok(roles.includes('assistant'), '已完成步骤的消息仍应保留');
});

test('取消优先于错误：流出现错误但用户已主动中止时仍为取消', async () => {
  const controller = new AbortController();
  const model = scriptedModel([interruptedTextStep(1, '不应按错误归类')]);
  const session = startConversation({
    model,
    messages: [{ role: 'user', content: '打个招呼' }],
    capabilities: DEFINITIONS,
    invoker: successRegistrar({ calls: [] }),
    signal: controller.signal,
  });
  controller.abort();

  const outcome = await session.outcome;
  assert.equal(outcome.status, 'cancelled', '用户中止不算 error');
  assert.equal(outcome.finishReason, 'abort');
});

test('取消：cancel 后循环停止，finish(abort)，工具收到已中止信号', async () => {
  let sessionRef;
  const model = scriptedModel([toolCallStep(1, 'knowledge__search'), textStep(2, '不应到达')]);
  const invoker = async (_capabilityId, _input, context) => {
    sessionRef.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.signal.aborted, true, '工具执行中应看到已中止的信号');
    return { status: 'success', value: { cancelled: true } };
  };

  sessionRef = startConversation({
    model,
    messages: [{ role: 'user', content: '检索产品 A' }],
    capabilities: DEFINITIONS,
    invoker,
  });

  const events = await collectEvents(sessionRef);
  const finish = events.find((e) => e.type === 'finish');
  assert.deepEqual(finish, { type: 'finish', reason: 'abort' });

  const outcome = await sessionRef.outcome;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(model.doStreamCalls.length, 1, '取消后不得发起第二次模型请求');
});

test('toFrameworkTools：全量转换，键为兼容工具名', () => {
  const tools = toFrameworkTools(DEFINITIONS, async () => ({
    status: 'success',
    value: null,
  }));
  assert.deepEqual(Object.keys(tools).sort(), [
    'knowledge__list_documents',
    'knowledge__read_document',
    'knowledge__search',
  ]);
  for (const candidate of DEFINITIONS) {
    const converted = tools[candidate.name];
    assert.equal(converted.description, candidate.description);
    assert.equal(typeof converted.execute, 'function');
  }
});

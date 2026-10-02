/**
 * AI SDK v7 spike 验证（选型文档 §4 清单，无网络，Mock 模型）。
 *
 * 验证项：
 * 1. 每次请求携带全量工具定义，无静默筛选
 * 2. stopWhen: isLoopFinished() 下多步循环无步数上限、自然结束
 * 3. abortSignal 取消：循环停止、工具处理器收到已中止的信号
 * 4. 工具调用 ID / 参数 / 结果在消息历史中保持对应
 * 5. 事件流可完整映射为统一会话事件（无未覆盖的关键事件类型）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamText, tool, jsonSchema, isLoopFinished } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

const TOOL_NAMES = ['knowledge__search', 'knowledge__read_document', 'knowledge__list_documents'];
const usage = {
  inputTokens: { total: 5, noCache: 5 },
  outputTokens: { total: 5, noCache: 5 },
};

function makeTools(record) {
  const tools = {};
  for (const name of TOOL_NAMES) {
    tools[name] = tool({
      description: `${name} 的公开能力（spike）`,
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }),
      execute: async (input, options) => {
        record.calls.push({ name, input, abortSignal: options?.abortSignal });
        return { echoed: input, tool: name };
      },
    });
  }
  return tools;
}

function toolCallStep(index, toolName, query = '产品 A') {
  const id = `tc-${index}`;
  const input = JSON.stringify({ query });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: `resp-${index}` },
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
    { type: 'response-metadata', id: `resp-${index}` },
    { type: 'text-start', id: `t-${index}` },
    { type: 'text-delta', id: `t-${index}`, delta: text },
    { type: 'text-end', id: `t-${index}` },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
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

function run(model, tools, options = {}) {
  return streamText({
    model,
    messages: [{ role: 'user', content: '检索知识库中关于产品 A 的资料' }],
    tools,
    stopWhen: isLoopFinished(),
    ...options,
  });
}

async function drain(result) {
  const parts = [];
  try {
    for await (const part of result.fullStream) parts.push(part);
  } catch (error) {
    parts.push({ type: 'iteration-thrown', error });
  }
  return parts;
}

test('spike 1+4+5: 全量工具提交、ID/参数/结果对应、事件流可映射', async () => {
  const record = { calls: [] };
  const model = scriptedModel([toolCallStep(1, 'knowledge__search'), textStep(2, '检索完成。')]);
  const result = run(model, makeTools(record), { abortSignal: new AbortController().signal });
  const parts = await drain(result);

  // 1. 每次模型请求都携带全量工具定义
  assert.equal(model.doStreamCalls.length, 2, '应有两次模型调用（工具步 + 收尾步）');
  for (const call of model.doStreamCalls) {
    assert.deepEqual(
      call.tools.map((t) => t.name).sort(),
      [...TOOL_NAMES].sort(),
      '每次请求的工具集合必须是全量',
    );
  }

  // 工具执行收到 AbortSignal（取消传播通道存在；前提是调用方传入信号——适配器应始终传入）
  assert.equal(record.calls.length, 1);
  assert.ok(record.calls[0].abortSignal instanceof AbortSignal, 'execute 应收到 abortSignal');
  assert.equal(
    record.calls[0].input && record.calls[0].input.query,
    '产品 A',
    'execute 收到的输入应与模型工具调用参数一致',
  );

  // 4. 消息历史中调用 ID / 参数/ 结果对应
  // v7 语义：result.response.messages 仅含最后一步；完整历史须经 result.steps 逐步累积。
  const steps = await result.steps;
  const messages = steps.flatMap((s) => s.response?.messages ?? []);
  const flat = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const toolCall = flat.find((p) => p.type === 'tool-call');
  const toolResult = flat.find((p) => p.type === 'tool-result');
  assert.ok(toolCall, '消息历史应包含 tool-call');
  assert.ok(toolResult, '消息历史应包含 tool-result');
  assert.equal(toolCall.toolCallId, 'tc-1');
  assert.equal(toolResult.toolCallId, 'tc-1', 'tool-result 的 toolCallId 必须与 tool-call 一致');
  assert.deepEqual(toolCall.input ?? JSON.parse(toolCall.args ?? '{}'), { query: '产品 A' });
  const rawOutput = toolResult.output ?? toolResult.result;
  // v7 将工具输出包装为 { type: 'json', value } 信封；适配层解包后交给结果展示
  const output =
    rawOutput && typeof rawOutput === 'object' && 'value' in rawOutput
      ? rawOutput.value
      : rawOutput;
  assert.deepEqual(
    output,
    { echoed: { query: '产品 A' }, tool: 'knowledge__search' },
    'tool-result 的输出必须是处理器真实返回值',
  );

  // 5. 事件流覆盖统一会话事件所需的关键类型
  const types = parts.map((p) => p.type);
  assert.ok(
    types.some((t) => t.startsWith('text')),
    `应包含文本事件，实际: ${types.join(',')}`,
  );
  assert.ok(types.includes('tool-call'), `应包含工具调用事件，实际: ${types.join(',')}`);
  assert.ok(types.includes('tool-result'), `应包含工具结果事件，实际: ${types.join(',')}`);
  assert.ok(types.includes('finish'), `应包含结束事件，实际: ${types.join(',')}`);
  assert.ok(!types.includes('error') && !types.includes('iteration-thrown'), '不应有错误事件');

  assert.equal(await result.text, '检索完成。');
});

test('spike 2: isLoopFinished() 下 31 步循环无步数上限，自然结束', async () => {
  const record = { calls: [] };
  const steps = [];
  for (let i = 1; i <= 30; i++) steps.push(toolCallStep(i, 'knowledge__list_documents'));
  steps.push(textStep(31, '全部完成。'));
  const model = scriptedModel(steps);

  const result = run(model, makeTools(record));
  await drain(result);

  assert.equal(model.doStreamCalls.length, 31, '31 次模型调用全部完成（超过默认 20 步安全上限）');
  assert.equal(record.calls.length, 30, '30 次工具执行全部完成');
  const finishReason = await result.finishReason;
  const unified = typeof finishReason === 'string' ? finishReason : finishReason?.unified;
  assert.equal(unified, 'stop', '应以自然结束收尾，而非步数上限');
});

test('spike 3: 中途 abort 取消——循环停止、工具收到已中止信号', async () => {
  const controller = new AbortController();
  const observed = { abortedAtTool: undefined };
  const model = scriptedModel([toolCallStep(1, 'knowledge__search'), textStep(2, '不应到达')]);

  const searchTool = tool({
    description: 'spike cancel',
    inputSchema: jsonSchema({ type: 'object', properties: {} }),
    execute: async (_input, options) => {
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      observed.abortedAtTool = options?.abortSignal?.aborted ?? false;
      return { cancelled: true };
    },
  });

  const result = run(model, { knowledge__search: searchTool }, { abortSignal: controller.signal });
  const parts = await drain(result);
  await result.text.catch(() => {}); // 取消后 text promise 可能拒绝，不视为失败

  assert.equal(observed.abortedAtTool, true, '工具处理器必须收到已中止的信号');
  assert.equal(model.doStreamCalls.length, 1, '取消后不得发起第二次模型请求（循环已停止）');
  const types = parts.map((p) => p.type);
  const aborted =
    types.includes('abort') ||
    types.includes('error') ||
    types.includes('iteration-thrown') ||
    types.some((t) => t.startsWith('abort'));
  assert.ok(aborted, `流应有中止指示，实际事件: ${types.join(',')}`);
});

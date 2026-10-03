/**
 * 端到端链路测试（无网络）：组合根运行时 → ModuleHost（内联测试模块）→ 适配层 → 能力调用 → 会话持久化。
 * 对应架构设计 §14.1 第 3 步：以测试夹具模块验证全量工具注册、调用及结果进入会话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { toolSuccess } from '@reisa/module-sdk';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createAppRuntime } from '../src/composition/runtime.ts';
import { ConversationManager } from '../src/main/conversation-manager.ts';
import { ConversationStore } from '../src/main/conversations/store.ts';

const usage = {
  inputTokens: { total: 5, noCache: 5 },
  outputTokens: { total: 5, noCache: 5 },
};

/** 测试夹具模块：提供一个真实执行的能力，代替尚未接入的业务模块。 */
function createTesterModule() {
  const tools = [
    {
      definition: {
        id: 'tester/upper',
        name: 'tester__upper',
        version: '0.1.0',
        description: '把输入文本转为大写',
        inputSchema: Type.Object({ text: Type.String() }),
        outputSchema: Type.Object({ text: Type.String() }),
      },
      execute: async (input) => toolSuccess({ text: input.text.toUpperCase() }),
    },
  ];
  return {
    id: 'tester',
    version: '0.1.0',
    protocolVersion: '1',
    async activate() {
      return { tools, deactivate: async () => {} };
    },
  };
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

function upperThenAnswerStep(toolName, text) {
  return [
    [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'tc-e2e', toolName, input: JSON.stringify({ text }) },
      { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: undefined } },
    ],
    [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: `结果是 ${text.toUpperCase()}。` },
      { type: 'text-end', id: 't1' },
      { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
    ],
  ];
}

test('端到端：运行时装配 → 测试模块能力调用 → 结果与记录持久化', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'reisa-e2e-'));
  const runtime = await createAppRuntime(userData);

  // 组合根已接入知识库运行模块：能力集合 = 内置知识库能力 + 测试夹具模块
  runtime.host.register(createTesterModule());
  await runtime.host.activate('tester');
  assert.equal(runtime.host.getState('tester'), 'active');
  assert.deepEqual(
    runtime.host
      .listEnabledCapabilities()
      .map((c) => c.id)
      .sort(),
    [
      'knowledge/list_documents',
      'knowledge/read_document',
      'knowledge/search',
      'knowledge/upload_document',
      'tester/upper',
    ],
  );

  const store = await ConversationStore.open(runtime.layout.conversationsDb);
  const conversation = store.createConversation('E2E 会话');
  const events = [];
  const manager = new ConversationManager({
    host: runtime.host,
    store,
    resolveModel: async () => scriptedModel(upperThenAnswerStep('tester__upper', 'hello reisa')),
    onEvent: (conversationId, event) => {
      assert.equal(conversationId, conversation.id);
      events.push(event);
    },
  });

  const turn = await manager.send(conversation.id, '请把 “hello reisa” 转成大写', [
    {
      name: '说明.md',
      mediaType: 'text/markdown',
      dataBase64: Buffer.from('# 附件说明\n这是一段随消息提交的文本附件。', 'utf8').toString(
        'base64',
      ),
    },
  ]);
  assert.equal(turn.status, 'completed');

  // 附件：元数据登记 + 副本落盘 + 文本内容内联进用户消息
  const attachments = store.listAttachments(conversation.id);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].name, '说明.md');
  const userContent = store
    .getMessages(conversation.id)
    .filter((m) => m.role === 'user')
    .map((m) => String(m.content))
    .join('\n');
  assert.ok(userContent.includes('--- 附件：说明.md ---'), '用户消息应内联文本附件内容');
  assert.ok(userContent.includes('这是一段随消息提交的文本附件'));

  const toolCall = events.find((e) => e.type === 'tool-call');
  const toolResult = events.find((e) => e.type === 'tool-result');
  const finish = events.find((e) => e.type === 'finish');
  assert.deepEqual(toolCall, {
    type: 'tool-call',
    toolCallId: 'tc-e2e',
    toolName: 'tester__upper',
    input: { text: 'hello reisa' },
  });
  assert.deepEqual(toolResult, {
    type: 'tool-result',
    toolCallId: 'tc-e2e',
    toolName: 'tester__upper',
    output: { text: 'HELLO REISA' },
  });
  assert.deepEqual(finish, { type: 'finish', reason: 'stop' });

  // 会话持久化：用户消息 + 框架完整历史（含工具调用与结果）
  const roles = store.getMessages(conversation.id).map((m) => m.role);
  assert.equal(roles[0], 'user');
  assert.ok(roles.includes('tool'), '工具结果消息应进入持久化历史');
  const parts = store
    .getMessages(conversation.id)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  assert.ok(
    parts.some((p) => p.type === 'tool-call' && p.toolName === 'tester__upper'),
    '持久化历史包含工具调用',
  );

  const records = store.listToolRecords(conversation.id);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'success');
  assert.equal(records[0].toolName, 'tester__upper');
  assert.equal(store.listConversations()[0].title, 'E2E 会话');
});

test('运行中二次发送被拒绝；停用模块后能力不可用', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'reisa-e2e-2-'));
  const runtime = await createAppRuntime(userData);
  runtime.host.register(createTesterModule());
  await runtime.host.activate('tester');
  const store = await ConversationStore.open(runtime.layout.conversationsDb);
  const conversation = store.createConversation();

  // 模型等待网关释放，制造运行中窗口
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const model = new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doStream: () => ({
      stream: gate.then(() => ({
        stream: simulateReadableStream({
          chunks: [
            [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'x' },
              { type: 'text-delta', id: 'x', delta: 'ok' },
              { type: 'text-end', id: 'x' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          ],
        }),
      })),
    }),
  });

  const manager = new ConversationManager({
    host: runtime.host,
    store,
    resolveModel: async () => model,
  });

  const first = manager.send(conversation.id, '第一句');
  await assert.rejects(
    () => manager.send(conversation.id, '第二句'),
    /正在运行中/,
    '同一会话不允许并发运行',
  );
  release();
  await first;

  // 停用测试模块后：全量能力集合收缩，直接调用返回结构化错误
  await runtime.host.deactivate('tester');
  assert.ok(!runtime.host.listEnabledCapabilities().some((c) => c.id.startsWith('tester/')));
  const unavailable = await runtime.host.invoke(
    'tester/upper',
    { text: 'x' },
    { invocationId: 'inv-x', signal: new AbortController().signal },
  );
  assert.equal(unavailable.status, 'error');
  assert.equal(unavailable.error?.code, 'CAPABILITY_UNAVAILABLE');
});

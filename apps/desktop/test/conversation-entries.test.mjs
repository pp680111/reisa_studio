/**
 * 渲染层历史转换测试：messagesToEntries 还原持久化消息为展示条目。
 * 重点：失败的工具调用（持久化错误形态 / 工具记录）重载后仍显示失败，而不是硬编码完成。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesToEntries } from '../src/renderer/conversation/entries.ts';

/** 构造持久化形态的工具调用消息（与框架 response.messages 一致）。 */
function toolMessages(toolCallId, output) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来查询。' },
        { type: 'tool-call', toolCallId, toolName: 'knowledge__search', input: { query: 'x' } },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId, toolName: 'knowledge__search', output }],
    },
  ];
}

test('成功工具调用：持久化后仍为 completed 并解包输出', () => {
  const entries = messagesToEntries(
    toolMessages('tc-1', { type: 'json', value: { hits: ['片段 A'] } }),
  );
  const tool = entries.find((e) => e.kind === 'tool');
  assert.equal(tool.status, 'completed');
  assert.deepEqual(tool.output, { hits: ['片段 A'] });
  assert.equal(tool.error, undefined);
});

test('持久化错误形态（error-text）：条目为 failed 且保留错误文案', () => {
  const entries = messagesToEntries(
    toolMessages('tc-1', { type: 'error-text', value: '文档不存在' }),
  );
  const tool = entries.find((e) => e.kind === 'tool');
  assert.equal(tool.status, 'failed');
  assert.equal(tool.error, '文档不存在');
  assert.equal(tool.output, undefined);
});

test('持久化错误形态（error-json）：条目为 failed 且错误可序列化展示', () => {
  const entries = messagesToEntries(
    toolMessages('tc-1', { type: 'error-json', value: { code: 'EXECUTION_FAILED' } }),
  );
  const tool = entries.find((e) => e.kind === 'tool');
  assert.equal(tool.status, 'failed');
  assert.ok(tool.error.includes('EXECUTION_FAILED'));
});

test('持久化 part 无失败信息时用工具记录兜底判定（按 toolCallId 关联）', () => {
  const entries = messagesToEntries(toolMessages('tc-1', { type: 'json', value: { any: true } }), [
    { invocationId: 'tc-other', status: 'success' },
    { invocationId: 'tc-1', status: 'error', errorCode: 'CAPABILITY_UNAVAILABLE' },
  ]);
  const tool = entries.find((e) => e.kind === 'tool');
  assert.equal(tool.status, 'failed');
  assert.equal(tool.error, 'CAPABILITY_UNAVAILABLE: 工具调用失败');
});

test('其他调用的错误记录不影响本次成功调用的状态', () => {
  const entries = messagesToEntries(toolMessages('tc-1', { type: 'json', value: 1 }), [
    { invocationId: 'tc-2', status: 'error', errorCode: 'X' },
  ]);
  const tool = entries.find((e) => e.kind === 'tool');
  assert.equal(tool.status, 'completed');
});

test('用户消息：附件内联内容截断，只展示正文与附件名', () => {
  const entries = messagesToEntries([
    { role: 'user', content: '帮我看一下\n\n--- 附件：说明.md ---\n正文内容' },
  ]);
  assert.deepEqual(entries, [{ kind: 'text', role: 'user', text: '帮我看一下\n附件：说明.md' }]);
});

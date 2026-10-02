// 真实模型端到端验证：复制用户基础配置到临时目录（隔离运行，不触碰正在使用的数据），
// 注册一个内联测试模块（echo 能力），经 ConversationManager 发起一轮真实会话，
// 验证连接、模型真实工具调用与持久化。
// 用法：node scripts/real-model-test.mjs <userData 路径>
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { appDataLayout } from '@reisa/foundation';
import { testModelConnection } from '@reisa/agent-adapter';
import { toolSuccess } from '@reisa/module-sdk';
import { createAppRuntime } from '../src/composition/runtime.ts';
import { ConversationManager } from '../src/main/conversation-manager.ts';
import { ConversationStore } from '../src/main/conversations/store.ts';

const realUserData = process.argv[2];
if (!realUserData) {
  console.error('用法：node scripts/real-model-test.mjs <userData 路径>');
  process.exit(1);
}

/** 内联测试模块：提供一个真实执行的 echo 能力，验证模型的工具调用循环。 */
function createProbeModule() {
  const tools = [
    {
      definition: {
        id: 'reisa-test/echo',
        name: 'reisa-test__echo',
        version: '0.1.0',
        description: '原样返回传入的文本，并附上字符数',
        inputSchema: Type.Object({ text: Type.String({ description: '要原样返回的文本' }) }),
        outputSchema: Type.Object({ text: Type.String(), length: Type.Number() }),
      },
      execute: async (input) => {
        const text = input.text;
        return toolSuccess({ text, length: text.length });
      },
    },
  ];
  return {
    id: 'reisa-test',
    version: '0.1.0',
    protocolVersion: '1',
    async activate() {
      return { tools, deactivate: async () => {} };
    },
  };
}

// createAppRuntime 在 userData 下使用 app-data/ 布局；复制时保持同样结构
const realLayout = appDataLayout(join(realUserData, 'app-data'));
const tempRoot = await mkdtemp(join(tmpdir(), 'reisa-real-test-'));
const layout = appDataLayout(join(tempRoot, 'app-data'));
await mkdir(layout.foundationDir, { recursive: true });
await copyFile(
  join(realLayout.foundationDir, 'settings.json'),
  join(layout.foundationDir, 'settings.json'),
);
await copyFile(
  join(realLayout.foundationDir, 'credentials.json'),
  join(layout.foundationDir, 'credentials.json'),
);

const runtime = await createAppRuntime(tempRoot);
runtime.host.register(createProbeModule());
await runtime.host.activate('reisa-test');

const connection = await runtime.config.get('modelConnection');
console.log(`模型连接：${connection.modelId} @ ${connection.baseURL}`);

const model = await runtime.resolveModel();
const test = await testModelConnection(model);
if (!test.ok) {
  console.error(`连接测试失败：${test.error}`);
  console.error('请检查设置页中的服务地址、模型 ID 与 API Key。');
  process.exit(1);
}
console.log(`连接测试通过：${test.reply}`);

const store = await ConversationStore.open(layout.conversationsDb);
const conversation = store.createConversation('真实模型验证');
const events = [];
const manager = new ConversationManager({
  host: runtime.host,
  store,
  resolveModel: runtime.resolveModel,
  onEvent: (_conversationId, event) => events.push(event),
});

const question =
  '请调用 reisa-test__echo 工具，传入文本“真实模型链路正常”，然后把工具返回的内容告诉我。';
console.log('提问:', question);
const turn = await manager.send(conversation.id, question);
console.log('运行状态:', turn.status);

for (const event of events) {
  if (event.type === 'tool-call')
    console.log('工具调用:', event.toolName, JSON.stringify(event.input));
  if (event.type === 'tool-result')
    console.log('工具结果:', JSON.stringify(event.output).slice(0, 400));
  if (event.type === 'tool-error')
    console.log('工具失败:', event.toolName, event.error.code, event.error.message);
  if (event.type === 'error') console.log('会话错误:', event.message);
}
const text = events
  .filter((event) => event.type === 'text-delta')
  .map((event) => event.text)
  .join('');
console.log('助手回答:', text);
console.log(
  '工具记录:',
  store
    .listToolRecords(conversation.id)
    .map((record) => `${record.toolName}:${record.status}`)
    .join(', ') || '（无）',
);
process.exit(turn.status === 'completed' ? 0 : 1);

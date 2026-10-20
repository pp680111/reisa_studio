import type { ConversationStore } from '../conversations/store.ts';

/**
 * 会话 system 消息解析（注入优先级）：
 * 1. 会话绑定角色 → 角色 prompt（includeBasePrompt 时把全局默认提示词拼在前面）；
 * 2. 无角色或角色缺失（理论上被删除保护挡住，兜底防数据手工改动）→ 全局默认提示词。
 * 每轮 send 时调用：角色 prompt 的编辑从使用它的会话下一轮开始生效。
 */
export async function resolveConversationSystemPrompt(options: {
  store: Pick<ConversationStore, 'getConversation' | 'getRole'>;
  getBasePrompt: () => Promise<string | undefined>;
  conversationId: string;
  warn?: (message: string) => void;
}): Promise<string | undefined> {
  const base = await options.getBasePrompt();
  const conversation = options.store.getConversation(options.conversationId);
  if (conversation?.roleId === undefined) return base;
  const role = options.store.getRole(conversation.roleId);
  if (role === undefined) {
    options.warn?.(
      `会话 ${options.conversationId} 绑定的角色缺失，回退默认提示词`,
    );
    return base;
  }
  const parts = [];
  if (role.includeBasePrompt && base?.trim() !== '') parts.push(base);
  if (role.prompt.trim() !== '') parts.push(role.prompt);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

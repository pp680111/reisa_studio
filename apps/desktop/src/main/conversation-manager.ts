import {
  startConversation,
  type ConversationEvent,
  type ConversationSession,
} from '@reisa/agent-adapter';
import type { LanguageModel, ModelMessage } from 'ai';
import type { ModuleHost } from '@reisa/module-host';
import { DEFAULT_CONVERSATION_TITLE, type ConversationStore } from './conversations/store.ts';

export interface ConversationManagerOptions {
  readonly host: ModuleHost;
  readonly store: ConversationStore;
  /** 每轮运行前解析模型；基础配置未就绪时抛出可展示错误。 */
  readonly resolveModel: () => Promise<LanguageModel>;
  /** 基础配置中的默认提示词；存在时作为本轮 system 消息提交。 */
  readonly resolveSystemPrompt?: () => Promise<string | undefined>;
  /** 事件出口：宿主经 IPC 推送给 renderer；事件即已发生的公开调用与结果。 */
  readonly onEvent?: (conversationId: string, event: ConversationEvent) => void;
}

export type TurnStatus = 'completed' | 'cancelled' | 'error';

/**
 * 会话运行编排（架构设计 §4.1）：历史 + 用户输入 → 框架运行 → 事件流 → 持久化。
 * 宿主不增加步数/时间/费用判断，取消经信号传给框架与模块。
 */
export class ConversationManager {
  readonly #options: ConversationManagerOptions;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: ConversationManagerOptions) {
    this.#options = options;
  }

  async send(conversationId: string, userText: string): Promise<{ status: TurnStatus }> {
    if (this.#controllers.has(conversationId)) {
      throw new Error('该会话正在运行中');
    }
    // 先占住运行位，再解析模型/读取历史，避免并发 send 在异步间隙溜入
    const controller = new AbortController();
    this.#controllers.set(conversationId, controller);
    try {
      const history = this.#options.store.getMessages(conversationId);
      const userMessage: ModelMessage = { role: 'user', content: userText };
      this.#options.store.appendMessages(conversationId, [userMessage]);
      // 首轮发送后用消息摘要替换默认标题，与 renderer 本地命名规则一致
      const summary = this.#options.store.getConversation(conversationId);
      if (summary && summary.title === DEFAULT_CONVERSATION_TITLE) {
        this.#options.store.renameConversation(conversationId, userText.slice(0, 20));
      }

      const [model, systemPrompt] = await Promise.all([
        this.#options.resolveModel(),
        this.#options.resolveSystemPrompt?.() ?? Promise.resolve(undefined),
      ]);
      const prompt = systemPrompt?.trim();
      const messages: ModelMessage[] = [
        ...(prompt ? [{ role: 'system', content: prompt } satisfies ModelMessage] : []),
        ...history,
        userMessage,
      ];
      const session: ConversationSession = startConversation({
        model,
        messages,
        capabilities: this.#options.host.listEnabledCapabilities(),
        invoker: this.#options.host.createInvoker(),
        signal: controller.signal,
      });
      for await (const event of session.events) {
        this.#recordToolEvent(conversationId, event);
        this.#options.onEvent?.(conversationId, event);
      }
      const outcome = await session.outcome;
      if (outcome.messages.length > 0) {
        this.#options.store.appendMessages(conversationId, outcome.messages);
      }
      return { status: outcome.status };
    } finally {
      this.#controllers.delete(conversationId);
    }
  }

  cancel(conversationId: string): void {
    this.#controllers.get(conversationId)?.abort();
  }

  isRunning(conversationId: string): boolean {
    return this.#controllers.has(conversationId);
  }

  #recordToolEvent(conversationId: string, event: ConversationEvent): void {
    if (event.type === 'tool-result') {
      this.#options.store.recordTool(conversationId, {
        invocationId: event.toolCallId,
        toolName: event.toolName,
        status: 'success',
      });
    }
    if (event.type === 'tool-error') {
      this.#options.store.recordTool(conversationId, {
        invocationId: event.toolCallId,
        toolName: event.toolName,
        status: 'error',
        errorCode: event.error.code,
      });
    }
  }
}

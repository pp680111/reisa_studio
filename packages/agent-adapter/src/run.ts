import { isLoopFinished, streamText, type LanguageModel, type ModelMessage } from 'ai';
import type { CapabilityDefinition, JsonValue } from '@reisa/module-sdk';
import {
  describeError,
  normalizeFinishReason,
  toCapabilityErrorPayload,
  unwrapToolOutput,
  type ConversationEvent,
  type ConversationFinishReason,
} from './events.ts';
import { toFrameworkTools, type CapabilityInvoker } from './tools.ts';

export interface StartConversationOptions {
  /** 模型实例；由基础连接服务构造（见 `createOpenAICompatibleModel`），适配层不管理凭据。 */
  readonly model: LanguageModel;
  /** 宿主持有的会话历史（含既往工具调用消息），每次运行整体提交。 */
  readonly messages: readonly ModelMessage[];
  /** 全量已启用能力描述（可序列化，不含执行函数）；每次请求完整提交，不筛选（架构设计 §6.2、§6.3）。 */
  readonly capabilities: readonly CapabilityDefinition[];
  /** 能力调用入口，绑定框架工具的执行回调。 */
  readonly invoker: CapabilityInvoker;
  /** 宿主侧取消信号（如页面关闭）；与会话内部信号合并后传给框架。 */
  readonly signal?: AbortSignal;
}

export interface ConversationOutcome {
  readonly status: 'completed' | 'cancelled' | 'error';
  readonly finishReason?: ConversationFinishReason;
  /** 本次运行产生的完整消息（含工具调用与结果），宿主持久化（架构设计 §7.4）。 */
  readonly messages: readonly ModelMessage[];
  readonly error?: string;
}

export interface ConversationSession {
  /** cancelConversation：转发用户取消信号（架构设计 §4.2）。 */
  readonly cancel: () => void;
  /** 统一会话事件流：文本、工具调用、结果、错误、结束。 */
  readonly events: AsyncIterable<ConversationEvent>;
  /** 运行结果；取消/失败路径下消息可能不完整，宿主应同时持久化事件流已确认的内容。 */
  readonly outcome: Promise<ConversationOutcome>;
}

interface StreamPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  finishReason?: unknown;
}

interface RunHandle {
  readonly fullStream: AsyncIterable<StreamPart>;
  readonly steps: Promise<readonly { response?: { messages?: readonly unknown[] } }[]>;
  readonly finishReason: Promise<unknown>;
}

/** startConversation：提交会话、模型、全量工具与调用入口，返回事件流与结果（架构设计 §4.2）。 */
export function startConversation(options: StartConversationOptions): ConversationSession {
  const controller = new AbortController();
  // 框架仅在传入信号时才向工具下发 abortSignal（选型文档 §4.1），因此始终传入。
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  const result = streamText({
    model: options.model,
    messages: [...options.messages],
    tools: toFrameworkTools(options.capabilities, options.invoker),
    stopWhen: isLoopFinished(),
    abortSignal: signal,
  }) as unknown as RunHandle;

  return {
    cancel: () => controller.abort(),
    events: mapConversationEvents(result.fullStream),
    outcome: collectOutcome(result, signal),
  };
}

async function* mapConversationEvents(
  fullStream: AsyncIterable<StreamPart>,
): AsyncGenerator<ConversationEvent> {
  for await (const part of fullStream) {
    switch (part.type) {
      case 'text-delta':
        yield { type: 'text-delta', text: part.text ?? '' };
        break;
      case 'tool-call':
        yield {
          type: 'tool-call',
          toolCallId: part.toolCallId ?? '',
          toolName: part.toolName ?? '',
          input: (part.input ?? {}) as JsonValue,
        };
        break;
      case 'tool-result':
        yield {
          type: 'tool-result',
          toolCallId: part.toolCallId ?? '',
          toolName: part.toolName ?? '',
          output: unwrapToolOutput(part.output),
        };
        break;
      case 'tool-error':
        yield {
          type: 'tool-error',
          toolCallId: part.toolCallId ?? '',
          toolName: part.toolName ?? '',
          error: toCapabilityErrorPayload(part.error),
        };
        break;
      case 'error':
        yield { type: 'error', message: describeError(part.error) };
        break;
      case 'abort':
        yield { type: 'finish', reason: 'abort' };
        return;
      case 'finish':
        yield { type: 'finish', reason: normalizeFinishReason(part.finishReason) };
        return;
      default:
        break; // start / step 边界等宿主暂不消费的事件
    }
  }
}

async function collectOutcome(
  result: RunHandle,
  signal: AbortSignal,
): Promise<ConversationOutcome> {
  let finishReason: ConversationFinishReason | undefined;
  try {
    finishReason = normalizeFinishReason(await result.finishReason);
  } catch {
    // 结束原因不可得时按实际状态归类
  }

  let messages: ModelMessage[] = [];
  let failure: unknown;
  try {
    // v7 语义：result.response.messages 仅含最后一步；完整历史须经 steps 累积（选型文档 §4.1）。
    const steps = await result.steps;
    messages = steps.flatMap(
      (step) => (step.response?.messages ?? []) as unknown as ModelMessage[],
    );
  } catch (error) {
    failure = error;
  }

  if (signal.aborted) {
    return { status: 'cancelled', finishReason: 'abort', messages };
  }
  if (failure) {
    return { status: 'error', finishReason, messages, error: describeError(failure) };
  }
  return { status: 'completed', finishReason: finishReason ?? 'stop', messages };
}

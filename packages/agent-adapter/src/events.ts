import {
  CAPABILITY_ERROR_CODES,
  type CapabilityErrorPayload,
  type JsonValue,
} from '@reisa/module-sdk';

/**
 * 统一会话事件（架构设计 §4.2）：文本、工具调用、结果、错误与结束。
 * input / output 为框架已解析的 JSON 数据。
 */
export type ConversationFinishReason = 'stop' | 'abort' | 'error';

export type ConversationEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: 'tool-result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: JsonValue;
    }
  | {
      readonly type: 'tool-error';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly error: CapabilityErrorPayload;
    }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'finish'; readonly reason: ConversationFinishReason };

const CAPABILITY_ERROR_CODE_SET: ReadonlySet<string> = new Set(CAPABILITY_ERROR_CODES);

/** 外来错误归一为公开错误结构；内部细节不上浮（架构设计 §10.3）。 */
export function toCapabilityErrorPayload(error: unknown): CapabilityErrorPayload {
  const candidate = (error as { payload?: unknown } | null | undefined)?.payload;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'code' in candidate &&
    'message' in candidate &&
    CAPABILITY_ERROR_CODE_SET.has(String((candidate as { code: unknown }).code))
  ) {
    return candidate as CapabilityErrorPayload;
  }
  return {
    code: 'EXECUTION_FAILED',
    message: describeError(error),
    invocationId: '',
    retryable: false,
  };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** v7 将工具输出包装为 `{ type: 'json', value }` 信封；展示与持久化前解包（选型文档 §4.1）。 */
export function unwrapToolOutput(output: unknown): JsonValue {
  if (
    output &&
    typeof output === 'object' &&
    (output as { type?: unknown }).type === 'json' &&
    'value' in output
  ) {
    return (output as { value: JsonValue }).value;
  }
  return output as JsonValue;
}

/** 模型流部件的 finishReason 为 `{ unified, raw }` 结构（选型文档 §4.1）。 */
export function normalizeFinishReason(finishReason: unknown): ConversationFinishReason {
  const unified =
    typeof finishReason === 'string'
      ? finishReason
      : (finishReason as { unified?: unknown } | null | undefined)?.unified;
  if (unified === 'abort') return 'abort';
  if (unified === 'error') return 'error';
  return 'stop';
}

import type { JsonValue } from './json.ts';

/** 统一错误码（架构设计 §10.3）。 */
export const CAPABILITY_ERROR_CODES = [
  'CAPABILITY_UNAVAILABLE',
  'INVALID_INPUT',
  'RESOURCE_NOT_FOUND',
  'EXECUTION_FAILED',
  'CANCELLED',
] as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

/**
 * 可序列化的错误结构：调用 ID、公开消息与可重试标记。
 * 详细内部错误留在所属运行层，不把密钥、私有路径或内部数据返回给调用方或模型。
 */
export interface CapabilityErrorPayload {
  readonly code: CapabilityErrorCode;
  readonly message: string;
  readonly invocationId: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

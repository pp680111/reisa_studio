import type { CapabilityErrorPayload, CapabilityErrorCode } from './errors.ts';
import type { JsonSchema, JsonValue } from './json.ts';

/** 工具执行上下文：调用 ID 用于关联记录，取消信号用于响应用户操作（架构设计 §5）。 */
export interface ToolExecutionContext {
  readonly invocationId: string;
  readonly signal: AbortSignal;
}

export interface CapabilityDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
}

export interface ToolSuccessResult {
  readonly status: 'success';
  readonly value: JsonValue;
}

export interface ToolFailureResult {
  readonly status: 'error';
  readonly error: CapabilityErrorPayload;
}

/** 工具结果只能是成功值或结构化失败；不把失败转换为成功产物（架构设计 §10.3）。 */
export type ToolResult = ToolSuccessResult | ToolFailureResult;

/** 资源引用仅用于标识，不授予读取权（架构设计 §7.3）。 */
export interface ResourceReference {
  readonly kind: 'resource-reference';
  readonly ownerModuleId: string;
  readonly resourceId: string;
  readonly mediaType?: string;
  readonly summary?: string;
}

export interface ToolRegistration {
  readonly definition: CapabilityDefinition;
  execute(input: JsonValue, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface DefineCapabilityOptions {
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly version?: string;
}

export function defineCapability(
  moduleId: string,
  action: string,
  description: string,
  options: DefineCapabilityOptions = {},
): CapabilityDefinition {
  return {
    id: `${moduleId}/${action}`,
    name: `${moduleId}__${action}`,
    version: options.version ?? '0.1.0',
    description,
    inputSchema: options.inputSchema ?? { type: 'object', properties: {} },
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
  };
}

export function toolSuccess(value: JsonValue): ToolSuccessResult {
  return { status: 'success', value };
}

export function toolFailure(
  code: CapabilityErrorCode,
  message: string,
  invocationId: string,
  options: { retryable?: boolean; details?: JsonValue } = {},
): ToolFailureResult {
  return {
    status: 'error',
    error: {
      code,
      message,
      invocationId,
      retryable: options.retryable ?? false,
      ...(options.details !== undefined ? { details: options.details } : {}),
    },
  };
}

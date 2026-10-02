import { randomUUID } from 'node:crypto';
import { jsonSchema, tool as frameworkTool, type Tool } from 'ai';
import type {
  CapabilityDefinition,
  CapabilityErrorPayload,
  JsonValue,
  ToolExecutionContext,
  ToolResult,
} from '@reisa/module-sdk';

/** 能力调用入口（架构设计 §6.4）：由 module-host 提供；模块协作与人工调用共用同一入口。 */
export type CapabilityInvoker = (
  capabilityId: string,
  input: JsonValue,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

/** 携带公开错误负载的执行失败；fullStream 的 tool-error 部件会原样携带该错误对象。 */
export class CapabilityExecutionError extends Error {
  readonly payload: CapabilityErrorPayload;

  constructor(payload: CapabilityErrorPayload) {
    super(payload.message);
    this.name = 'CapabilityExecutionError';
    this.payload = payload;
  }
}

/**
 * toFrameworkTool：能力定义 → 框架工具，执行回调绑定能力调用入口（架构设计 §4.2）。
 * 适配层只接触可序列化的能力描述；执行函数与模块私有对象留在运行层（架构设计 §6.2）。
 */
export function toFrameworkTool(
  definition: CapabilityDefinition,
  invoker: CapabilityInvoker,
): Tool {
  return frameworkTool({
    description: definition.description,
    inputSchema: jsonSchema(definition.inputSchema as Record<string, unknown>),
    execute: async (input, options) => {
      const context: ToolExecutionContext = {
        invocationId: randomUUID(),
        // 框架仅在调用方传入信号时才下发 abortSignal（选型文档 §4.1）；此处兜底保证始终有信号。
        signal: options.abortSignal ?? new AbortController().signal,
      };
      const result = await invoker(definition.id, input as JsonValue, context);
      if (result.status === 'success') {
        return result.value;
      }
      throw new CapabilityExecutionError(result.error);
    },
  });
}

/** 全量转换：键为提交给模型的兼容工具名（`module__action`，架构设计 §6.1）。 */
export function toFrameworkTools(
  definitions: readonly CapabilityDefinition[],
  invoker: CapabilityInvoker,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const definition of definitions) {
    tools[definition.name] = toFrameworkTool(definition, invoker);
  }
  return tools;
}

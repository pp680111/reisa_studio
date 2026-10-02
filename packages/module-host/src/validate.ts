import { Kind, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { JsonSchema, JsonValue } from '@reisa/module-sdk';

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * 校验输入/输出是否符合能力声明的 JSON Schema（架构设计 §6.4）。
 * TypeBox 编写的 Schema（带 Kind 符号）执行完整校验；
 * 纯 JSON Schema（如占位声明）退化为最小结构检查，待模块接入真实 Schema 后自动生效。
 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): SchemaIssue[] {
  if (!schema || typeof schema !== 'object') return [];
  const kind = (schema as { [Kind]?: unknown })[Kind];
  if (kind !== undefined) {
    try {
      if (Value.Check(schema as TSchema, value)) return [];
      return [...Value.Errors(schema as TSchema, value)]
        .slice(0, 5)
        .map((error) => ({ path: error.path ?? '/', message: error.message }));
    } catch (error) {
      return [{ path: '/', message: `Schema 校验失败：${String(error)}` }];
    }
  }
  if ((schema as { type?: unknown }).type === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? []
      : [{ path: '/', message: 'Expected object' }];
  }
  return [];
}

/** 校验问题序列化为公开错误 details（可跨进程传输）。 */
export function issuesToJson(issues: readonly SchemaIssue[]): JsonValue {
  return issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

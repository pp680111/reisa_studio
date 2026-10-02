/** 跨进程可序列化值（架构设计 §5）。 */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * JSON Schema 表达的能力契约。具体校验库在实现层选用（见 docs/agent-framework-selection.md §5），
 * SDK 只持有可序列化的 Schema 本身。
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

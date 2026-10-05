/** 跨进程可序列化值（架构设计 §5）。 */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * JSON Schema 表达的能力契约。具体校验库在实现层选用（见 docs/agent-framework-selection.md §5），
 * SDK 只持有可序列化的 Schema 本身。
 *
 * 校验语义由宿主实现（module-host，输入与输出共用同一入口）：
 * - 带 TypeBox Kind 符号的 Schema：完整校验（@sinclair/typebox Value.Check）。
 * - 纯 JSON Schema：务实子集校验——type（含数组形式与 'null' 成员）、nullable、
 *   properties/required、items（含元组形式）、enum/const；其余关键字按 JSON Schema 语义忽略；
 *   无任何约束的空 Schema（{}）不施加限制；Schema 自身非法（未知 type、形状错误）按校验失败处理。
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

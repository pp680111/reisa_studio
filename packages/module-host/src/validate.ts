import { Kind, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { JsonSchema, JsonValue } from '@reisa/module-sdk';

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * 校验输入/输出是否符合能力声明的 JSON Schema（架构设计 §6.4）；输入与输出共用同一实现。
 * - TypeBox 编写的 Schema（带 Kind 符号）：执行完整校验（@sinclair/typebox）。
 * - 纯 JSON Schema：执行务实子集校验（checkJsonSchemaSubset）——覆盖 type（含数组形式与
 *   'null' 成员）、properties/required、items（含 draft-07 元组形式）、enum/const、nullable；
 *   其余关键字按 JSON Schema 语义忽略；无任何约束的空 Schema（{}）不施加限制（向后兼容）。
 *   Schema 自身写错（type 取值未知、properties/required 形状非法）按校验失败处理，不静默放行。
 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): SchemaIssue[] {
  // 未声明 Schema（undefined/null）视为无约束，保持既有调用方行为
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
  const issues: SchemaIssue[] = [];
  checkJsonSchemaSubset(schema as Readonly<Record<string, unknown>>, value, '/', issues);
  return issues;
}

/** 子集支持的简单类型名；'integer' 按 JSON Schema 语义（无小数部分的 number）。 */
const SIMPLE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/**
 * 纯 JSON Schema 的务实子集校验：issues 就地收集，path 为 JSON Pointer 风格（'/field/0'）。
 * 关键字彼此独立生效（如无 type 时 properties 仍按对象值递归），与 JSON Schema 一致。
 */
function checkJsonSchemaSubset(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): void {
  if (!isPlainObject(schema)) {
    issues.push({ path, message: 'Schema 定义无效（必须是对象）' });
    return;
  }
  if (schema['enum'] !== undefined) {
    const options = schema['enum'];
    if (!Array.isArray(options)) {
      issues.push({ path, message: 'Schema 定义无效（enum 必须是数组）' });
      return;
    }
    if (!options.some((option) => deepEquals(option, value))) {
      issues.push({ path, message: `值必须是枚举成员之一：${JSON.stringify(options)}` });
      return;
    }
  }
  if (schema['const'] !== undefined && !deepEquals(schema['const'], value)) {
    issues.push({ path, message: `值必须等于常量 ${JSON.stringify(schema['const'])}` });
    return;
  }
  const declared = schema['type'];
  if (declared !== undefined) {
    const types = Array.isArray(declared) ? declared : [declared];
    for (const type of types) {
      if (typeof type !== 'string' || !SIMPLE_TYPES.has(type)) {
        issues.push({ path, message: `Schema 定义无效（未知 type：${JSON.stringify(type)}）` });
        return;
      }
    }
    // 可空语义：type 数组含 'null'，或 OpenAPI 风格的 nullable: true
    if (value === null) {
      if (!(schema['nullable'] === true || types.includes('null'))) {
        issues.push({ path, message: '值不可为 null' });
      }
      return;
    }
    const expected = types.filter((type) => type !== 'null');
    if (!expected.some((type) => matchesType(type, value))) {
      issues.push({ path, message: `类型应为 ${expected.join(' | ')}` });
      return;
    }
  }
  if (isPlainObject(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    const properties = schema['properties'];
    if (properties !== undefined) {
      if (!isPlainObject(properties)) {
        issues.push({ path, message: 'Schema 定义无效（properties 必须是对象）' });
        return;
      }
      for (const [key, subschema] of Object.entries(properties)) {
        if (record[key] !== undefined) {
          checkJsonSchemaSubset(
            subschema as Readonly<Record<string, unknown>>,
            record[key],
            joinPath(path, key),
            issues,
          );
        }
      }
    }
    const required = schema['required'];
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every((key) => typeof key === 'string')) {
        issues.push({ path, message: 'Schema 定义无效（required 必须是字符串数组）' });
        return;
      }
      for (const key of required) {
        if (record[key] === undefined) {
          issues.push({ path: joinPath(path, key), message: `缺少必填字段 ${key}` });
        }
      }
    }
  }
  if (Array.isArray(value)) {
    const items = schema['items'];
    if (items !== undefined) {
      if (Array.isArray(items)) {
        // draft-07 元组形式：按位校验，超出元组长度的项不约束
        items.forEach((subschema, index) => {
          if (index < value.length) {
            checkJsonSchemaSubset(
              subschema as Readonly<Record<string, unknown>>,
              value[index],
              joinPath(path, String(index)),
              issues,
            );
          }
        });
      } else {
        value.forEach((item, index) => {
          checkJsonSchemaSubset(
            items as Readonly<Record<string, unknown>>,
            item,
            joinPath(path, String(index)),
            issues,
          );
        });
      }
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 枚举/常量成员比较：原始值恒等，对象/数组按键逐一深度相等。 */
function deepEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isPlainObject(left) && !Array.isArray(left)) return false;
  if (!isPlainObject(right) && !Array.isArray(right)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => deepEquals(leftRecord[key], rightRecord[key]))
  );
}

function joinPath(path: string, key: string): string {
  return path === '/' ? `/${key}` : `${path}/${key}`;
}

/** 校验问题序列化为公开错误 details（可跨进程传输）。 */
export function issuesToJson(issues: readonly SchemaIssue[]): JsonValue {
  return issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

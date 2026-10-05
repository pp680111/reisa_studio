/**
 * Schema 校验测试（R7）：TypeBox 路径完整校验不变；纯 JSON Schema 走务实子集校验，
 * 输入与输出共用同一实现，不再对非对象输入"只查顶层"放行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { ModuleHost } from '../src/index.ts';
import { validateAgainstSchema } from '../src/validate.ts';
import { toolSuccess } from '@reisa/module-sdk';

/** 纯 JSON Schema（无 Kind 符号）：数字字段传字符串必须被拒（R7 反例）。 */
test('子集校验：数字字段传字符串被拒，路径指向字段', () => {
  const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
  const issues = validateAgainstSchema(schema, { n: 'abc' });
  assert.ok(issues.length > 0, '声明 number 传入字符串应被拒绝');
  assert.equal(issues[0]?.path, '/n');
  assert.deepEqual(validateAgainstSchema(schema, { n: 3 }), []);
});

test('子集校验：required 缺失被拒', () => {
  const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
  const issues = validateAgainstSchema(schema, {});
  assert.ok(issues.length > 0);
  assert.equal(issues[0]?.path, '/n');
});

test('子集校验：嵌套 properties 递归校验', () => {
  const schema = {
    type: 'object',
    properties: {
      inner: {
        type: 'object',
        properties: { x: { type: 'string' } },
        required: ['x'],
      },
    },
    required: ['inner'],
  };
  assert.deepEqual(validateAgainstSchema(schema, { inner: { x: '好' } }), []);
  const issues = validateAgainstSchema(schema, { inner: { x: 1 } });
  assert.ok(issues.length > 0);
  assert.equal(issues[0]?.path, '/inner/x');
});

test('子集校验：数组 items 逐项校验', () => {
  const schema = { type: 'array', items: { type: 'number' } };
  assert.deepEqual(validateAgainstSchema(schema, [1, 2, 3]), []);
  const issues = validateAgainstSchema(schema, [1, 'a']);
  assert.ok(issues.length > 0);
  assert.equal(issues[0]?.path, '/1');
  // draft-07 元组形式：按位约束
  const tuple = { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] };
  assert.deepEqual(validateAgainstSchema(tuple, ['a', 2]), []);
  assert.ok(validateAgainstSchema(tuple, ['a', 'b']).length > 0);
});

test('子集校验：enum 与 const', () => {
  assert.deepEqual(validateAgainstSchema({ enum: ['a', 'b'] }, 'a'), []);
  assert.ok(validateAgainstSchema({ enum: ['a', 'b'] }, 'c').length > 0);
  assert.deepEqual(validateAgainstSchema({ const: 7 }, 7), []);
  assert.ok(validateAgainstSchema({ const: 7 }, 8).length > 0);
});

test('子集校验：可空语义（type 数组含 null 与 nullable）', () => {
  const nullableUnion = { type: ['string', 'null'] };
  assert.deepEqual(validateAgainstSchema(nullableUnion, null), []);
  assert.deepEqual(validateAgainstSchema(nullableUnion, '文本'), []);
  assert.ok(validateAgainstSchema(nullableUnion, 5).length > 0);
  const openapiNullable = { type: 'string', nullable: true };
  assert.deepEqual(validateAgainstSchema(openapiNullable, null), []);
  assert.ok(validateAgainstSchema(openapiNullable, 5).length > 0);
});

test('子集校验：空 Schema 不施加任何约束（向后兼容）', () => {
  assert.deepEqual(validateAgainstSchema({}, 5), []);
  assert.deepEqual(validateAgainstSchema({}, '任意'), []);
  assert.deepEqual(validateAgainstSchema({}, { a: [1, null] }), []);
  assert.deepEqual(validateAgainstSchema({}, null), []);
});

test('子集校验：未知关键字按 JSON Schema 语义忽略', () => {
  const schema = { type: 'string', minLength: 5, format: 'email' };
  assert.deepEqual(validateAgainstSchema(schema, 'abc'), []);
});

test('子集校验：Schema 自身非法按校验失败处理，不静默放行', () => {
  assert.ok(validateAgainstSchema({ type: 'strng' }, '任意值').length > 0, '未知 type 值应拒绝');
  assert.ok(
    validateAgainstSchema({ type: 'object', properties: { n: 'number' } }, { n: 1 }).length > 0,
    'properties 成员必须是 Schema 对象',
  );
  assert.ok(
    validateAgainstSchema({ type: 'object', required: 'n' }, { n: 1 }).length > 0,
    'required 必须是字符串数组',
  );
});

test('TypeBox Kind Schema 行为不变：完整校验继续生效', () => {
  const schema = Type.Object({ n: Type.Number() });
  assert.deepEqual(validateAgainstSchema(schema, { n: 1 }), []);
  const issues = validateAgainstSchema(schema, { n: '不是数字' });
  assert.ok(issues.length > 0);
  assert.equal(issues[0]?.path, '/n');
});

function makeTool(id, action, inputSchema, execute, outputSchema) {
  return {
    definition: {
      id,
      name: `${id.split('/')[0]}__${action}`,
      version: '0.1.0',
      description: `${id} 测试能力`,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
    },
    execute,
  };
}

function makeModule(id, tools) {
  return {
    id,
    version: '0.1.0',
    protocolVersion: '1',
    async activate() {
      return { tools, deactivate: async () => {} };
    },
  };
}

const invocation = (invocationId) => ({ invocationId, signal: new AbortController().signal });

test('宿主 invoke：纯 JSON Schema 声明的输入被完整校验（INVALID_INPUT）', async () => {
  const host = new ModuleHost({ storageRoot: await mkdtempRoot() });
  let called = false;
  const tool = makeTool(
    'math/double',
    'double',
    { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    async () => {
      called = true;
      return toolSuccess({});
    },
  );
  host.register(makeModule('math', [tool]));
  await host.activate('math');

  const bad = await host.invoke('math/double', { n: 'abc' }, invocation('inv-r7-1'));
  assert.equal(bad.status, 'error');
  assert.equal(bad.error?.code, 'INVALID_INPUT');
  assert.equal(called, false, '校验失败不进入处理器');

  const good = await host.invoke('math/double', { n: 4 }, invocation('inv-r7-2'));
  assert.equal(good.status, 'success');
  assert.equal(called, true);
});

test('宿主 invoke：纯 JSON Schema 声明的输出校验同样生效（EXECUTION_FAILED）', async () => {
  const host = new ModuleHost({ storageRoot: await mkdtempRoot() });
  const tool = makeTool(
    'math/sum',
    'sum',
    { type: 'object', properties: {}, required: [] },
    async () => toolSuccess({ result: '应为数字' }),
    { type: 'object', properties: { result: { type: 'number' } }, required: ['result'] },
  );
  host.register(makeModule('math', [tool]));
  await host.activate('math');

  const result = await host.invoke('math/sum', {}, invocation('inv-r7-3'));
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'EXECUTION_FAILED');
  assert.ok(result.error?.details?.length > 0, '输出不符声明应携带校验细节');
});

async function mkdtempRoot() {
  return mkdtemp(join(tmpdir(), 'reisa-validate-'));
}

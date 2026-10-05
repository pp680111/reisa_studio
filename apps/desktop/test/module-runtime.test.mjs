/**
 * 宿主运行状态投影回归（架构设计 §10）：
 * 状态映射保留 failed 原因；启用集合以宿主为唯一来源；
 * 过渡态可区分（用于禁用重复启停操作）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEnabledModules,
  isTransitioning,
  toRuntimeStates,
  toRuntimeStatus,
} from '../src/renderer/shell/moduleRuntime.ts';

test('ModuleStatus[] → 状态映射保留 error 字段', () => {
  const states = toRuntimeStates([
    { id: 'knowledge', version: '0.1.0', state: 'failed', error: '数据库打开失败' },
    { id: 'card-note', version: '0.1.0', state: 'active' },
  ]);
  assert.deepEqual(states.knowledge, { state: 'failed', error: '数据库打开失败' });
  assert.deepEqual(states['card-note'], { state: 'active' });
  assert.equal(states['card-note'].error, undefined);
});

test('单条状态投影：无 error 时不产出空字段', () => {
  assert.deepEqual(toRuntimeStatus({ state: 'activating' }), { state: 'activating' });
  assert.deepEqual(toRuntimeStatus({ state: 'failed', error: 'x' }), {
    state: 'failed',
    error: 'x',
  });
});

test('启用集合派生：disabled 排除，过渡态与 failed 视为启用，未登记模块保持可用', () => {
  const states = toRuntimeStates([
    { id: 'a', state: 'disabled' },
    { id: 'b', state: 'activating' },
    { id: 'c', state: 'deactivating' },
    { id: 'd', state: 'failed', error: 'x' },
    { id: 'e', state: 'active' },
  ]);
  assert.deepEqual(deriveEnabledModules(['a', 'b', 'c', 'd', 'e', 'prototype'], states), [
    'b',
    'c',
    'd',
    'e',
    'prototype',
  ]);
});

test('浏览器预览（无宿主状态）全部模块可用', () => {
  assert.deepEqual(deriveEnabledModules(['knowledge', 'card-note'], {}), [
    'knowledge',
    'card-note',
  ]);
});

test('过渡态可区分：activating/deactivating 为过渡，其余状态不是', () => {
  assert.equal(isTransitioning('activating'), true);
  assert.equal(isTransitioning('deactivating'), true);
  for (const state of ['disabled', 'active', 'failed', undefined]) {
    assert.equal(isTransitioning(state), false);
  }
});

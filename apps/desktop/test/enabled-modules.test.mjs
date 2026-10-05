/**
 * 启用清单默认语义回归（架构设计 §8.1）：
 * 缺失配置播种为完整启用清单（缺失 = 全启用，与组合根缺省语义一致）；
 * 首次停用一个模块后持久化清单仍含其余模块，重启不会全部被停用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextEnabledModules } from '../src/main/enabled-modules.ts';

const ALL = ['knowledge', 'card-note'];

test('缺失配置播种为全部模块；首次停用一个后其余模块保留', () => {
  assert.deepEqual(nextEnabledModules(undefined, ALL, 'knowledge', false), ['card-note']);
  assert.deepEqual(nextEnabledModules(undefined, ALL, 'card-note', false), ['knowledge']);
});

test('缺失配置下启用模块得到完整清单且不重复', () => {
  assert.deepEqual(nextEnabledModules(undefined, ALL, 'card-note', true), [
    'knowledge',
    'card-note',
  ]);
  assert.deepEqual(nextEnabledModules(undefined, ALL, 'knowledge', true), [
    'knowledge',
    'card-note',
  ]);
});

test('持久化清单继续生效：逐个停用得到空清单，重新启用按需恢复', () => {
  const afterFirst = nextEnabledModules(undefined, ALL, 'knowledge', false);
  assert.deepEqual(nextEnabledModules(afterFirst, ALL, 'card-note', false), []);
  // 空数组是用户显式停用全部的有效配置，不再是「缺失」
  assert.deepEqual(nextEnabledModules([], ALL, 'knowledge', true), ['knowledge']);
});

test('已包含的模块重复启用保持原顺序且不产生重复项', () => {
  assert.deepEqual(nextEnabledModules(ALL, ALL, 'knowledge', true), ALL);
  assert.deepEqual(nextEnabledModules(['card-note', 'knowledge'], ALL, 'card-note', true), [
    'card-note',
    'knowledge',
  ]);
});

test('损坏配置（null/非数组）视同缺失并播种完整清单', () => {
  assert.deepEqual(nextEnabledModules(null, ALL, 'knowledge', false), ['card-note']);
  assert.deepEqual(nextEnabledModules('corrupted', ALL, 'knowledge', true), ALL);
});

test('清单中未登记的历史条目在增删时保留', () => {
  const legacy = [...ALL, 'external-legacy'];
  assert.deepEqual(nextEnabledModules(legacy, ALL, 'knowledge', false), [
    'card-note',
    'external-legacy',
  ]);
});

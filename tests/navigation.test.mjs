import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationModules } from '../apps/desktop/src/renderer/shell/navigation.mjs';

const modules = Array.from({ length: 36 }, (_, index) => ({
  id: `module-${index}`,
  name: `模块 ${index}`,
  navigation: { aliases: [`Workspace ${index}`], keywords: [`用途${index}`] },
}));
const enabled = modules.map((module) => module.id);
test('all 36 enabled module entries remain reachable; tool-only and disabled modules are excluded', () => {
  assert.equal(
    navigationModules([...modules, { id: 'tool-only', name: '工具' }], [...enabled, 'tool-only'])
      .length,
    36,
  );
  assert.equal(
    navigationModules(
      modules,
      enabled.filter((id) => id !== 'module-35'),
      [],
      [],
      '用途35',
    ).length,
    0,
  );
});
test('public aliases and Chinese usage keywords match without reading private content', () => {
  assert.equal(navigationModules(modules, enabled, [], [], 'workspace 35')[0].id, 'module-35');
  assert.equal(navigationModules(modules, enabled, [], [], ' 用途35 ')[0].id, 'module-35');
  assert.deepEqual(navigationModules(modules, enabled, [], [], '未公开文档内容'), []);
});
test('pinned ordering precedes recent entries without duplicate navigation', () => {
  const sorted = navigationModules(
    modules,
    enabled,
    ['module-31', 'module-2'],
    ['module-2', 'module-35'],
  );
  assert.deepEqual(
    sorted.slice(0, 3).map((module) => module.id),
    ['module-31', 'module-2', 'module-35'],
  );
  assert.equal(new Set(sorted.map((module) => module.id)).size, 36);
});

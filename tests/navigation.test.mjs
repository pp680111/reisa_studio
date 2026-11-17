import test from 'node:test';
import assert from 'node:assert/strict';
import {
  navigationModules,
  quickSwitcherModules,
} from '../apps/desktop/src/renderer/shell/navigation.mjs';

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

test('quickSwitcherModules includes modules with settings even without navigation', () => {
  const repoModule = {
    id: 'repo-explorer',
    name: '代码仓库',
    description: '注册本地代码仓库，为会话提供只读的虚拟路径代码检索工具',
    settings: () => null,
  };
  const allModules = [...modules, repoModule];
  const allEnabled = [...enabled, 'repo-explorer'];

  // 搜索 "代码" 可匹配到没有 navigation 但有 settings 的模块
  const byName = quickSwitcherModules(allModules, allEnabled, [], [], '代码');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].id, 'repo-explorer');

  // 搜索 "检索" 可通过 description 匹配
  const byDesc = quickSwitcherModules(allModules, allEnabled, [], [], '检索');
  assert.equal(byDesc.length, 1);
  assert.equal(byDesc[0].id, 'repo-explorer');

  // 未启用的模块不应被搜出
  const disabledMatch = quickSwitcherModules(allModules, enabled, [], [], '代码');
  assert.equal(disabledMatch.length, 0);
});

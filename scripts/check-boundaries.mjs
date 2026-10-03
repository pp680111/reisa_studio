import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { builtinModules } from 'node:module';
const root = resolve(import.meta.dirname, '..');
const violations = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'dist-electron'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!/\.(?:ts|tsx|mjs)$/.test(entry.name) || entry.name.endsWith('.d.mts')) continue;
    const file = relative(root, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    // renderer 侧代码：宿主 renderer、模块 UI/设置/契约、共享 UI 包。
    // 模块 runtime/storage 是主进程运行层，允许使用平台模块。
    const renderer =
      file.includes('/renderer/') ||
      /^modules\/[^/]+\/(ui|settings|contracts)\//.test(file) ||
      file.startsWith('packages/ui/');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const dependency = match[1];
      const target = dependency.startsWith('.')
        ? relative(root, resolve(directory, dependency)).replaceAll('\\', '/')
        : dependency;
      if (
        renderer &&
        (dependency.startsWith('node:') ||
          dependency === 'electron' ||
          builtinModules.includes(dependency))
      )
        violations.push(`${file}: renderer imports platform module ${dependency}`);
      if (
        file.startsWith('packages/') &&
        (target.startsWith('modules/') ||
          (dependency.startsWith('@reisa/module-') && dependency !== '@reisa/module-sdk'))
      )
        violations.push(`${file}: foundation/shared package imports business module ${dependency}`);
      if (
        file.startsWith('apps/desktop/src/renderer/') &&
        dependency.startsWith('@reisa/') &&
        dependency !== '@reisa/module-sdk' &&
        !dependency.startsWith('@reisa/ui')
      )
        violations.push(
          `${file}: host renderer must use the composition root for module contributions`,
        );
      if (file.startsWith('modules/')) {
        const owner = file.split('/')[1];
        // 模块测试允许引用 module-host（端到端装配验证）；运行时代码仍只能依赖 SDK 与自身
        const allowedShared = file.includes('/test/')
          ? ['@reisa/module-sdk', '@reisa/module-host']
          : ['@reisa/module-sdk'];
        if (
          (dependency.startsWith('@reisa/module-') &&
            !allowedShared.includes(dependency) &&
            dependency !== `@reisa/module-${owner}`) ||
          (target.startsWith('modules/') && !target.startsWith(`modules/${owner}/`))
        )
          violations.push(`${file}: cross-module import ${dependency}`);
      }
      const isRuntimeEntry =
        file.startsWith('apps/desktop/src/composition/') &&
        /^@reisa\/module-[^/]+\/runtime$/.test(dependency);
      if (/^@reisa\/[^/]+\/(storage|settings|ui)(?:\/|$)/.test(dependency))
        violations.push(`${file}: private package subpath ${dependency}`);
      if (/^@reisa\/[^/]+\/runtime(?:\/|$)/.test(dependency) && !isRuntimeEntry)
        violations.push(`${file}: runtime entry may only be imported by the composition root`);
    }
  }
}
for (const directory of ['apps', 'packages', 'modules']) {
  if (existsSync(join(root, directory))) await visit(join(root, directory));
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Package boundaries passed: renderer/platform, composition root, shared packages, and module isolation.',
  );

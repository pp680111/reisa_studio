import { readdir, readFile } from 'node:fs/promises';
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
    const renderer =
      file.includes('/renderer/') || file.startsWith('modules/') || file.startsWith('packages/ui/');
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
        ((dependency.startsWith('@reisa/module-') && dependency !== '@reisa/module-sdk') ||
          target.startsWith('modules/'))
      )
        violations.push(
          `${file}: host renderer must use the composition root for module contributions`,
        );
      if (file.startsWith('modules/')) {
        const owner = file.split('/')[1];
        if (
          (dependency.startsWith('@reisa/module-') &&
            dependency !== '@reisa/module-sdk' &&
            dependency !== `@reisa/module-${owner}`) ||
          (target.startsWith('modules/') && !target.startsWith(`modules/${owner}/`))
        )
          violations.push(`${file}: cross-module import ${dependency}`);
      }
      if (/^@reisa\/[^/]+\/(runtime|storage|settings|ui)(?:\/|$)/.test(dependency))
        violations.push(`${file}: private package subpath ${dependency}`);
    }
  }
}
for (const directory of ['apps', 'packages', 'modules']) await visit(join(root, directory));
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Package boundaries passed: renderer/platform, composition root, shared packages, and module isolation.',
  );

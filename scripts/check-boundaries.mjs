import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const SKIP_DIRECTORIES = ['node_modules', 'dist', 'dist-electron'];
const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
const PRIVATE_SUBPATH_PATTERN = /^@reisa\/[^/]+\/(storage|settings|ui)(?:\/|$)/;
const RUNTIME_ENTRY_PATTERN = /^@reisa\/[^/]+\/runtime(?:\/|$)/;

/** 收集工作区包名 → 仓库内目录（用于把 @reisa/* 说明符解析为实际导入目标）。 */
async function collectWorkspacePackages(rootDir) {
  const packages = new Map();
  for (const group of ['apps', 'packages', 'modules']) {
    const groupDir = join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(groupDir, entry.name, 'package.json');
      if (!existsSync(manifest)) continue;
      try {
        const name = JSON.parse(await readFile(manifest, 'utf8'))?.name;
        if (typeof name === 'string') packages.set(name, `${group}/${entry.name}`);
      } catch {
        // 包清单损坏时跳过：相关说明符按未解析处理，仍受说明符形态规则约束
      }
    }
  }
  return packages;
}

/**
 * 边界检查：规则作用于实际导入目标而不是说明符字符串——
 * 相对路径 resolve 成仓库内文件，@reisa/* 解析成包目录（+子路径）后再判定。
 * 返回违规列表（空数组 = 通过），供 CLI 与回归测试共用。
 */
export async function checkBoundaries(rootDir) {
  const workspacePackages = await collectWorkspacePackages(rootDir);
  const violations = [];
  const toRepoPath = (absolutePath) => relative(rootDir, absolutePath).replaceAll('\\', '/');

  /** 解析一条导入的实际目标：相对路径 → 仓库内文件；@reisa/* → 包目录/子路径；其余原样。 */
  const resolveTarget = (fromDir, specifier) => {
    if (specifier.startsWith('.')) {
      return { kind: 'file', target: toRepoPath(resolve(fromDir, specifier)) };
    }
    if (specifier.startsWith('@reisa/')) {
      const [scope, name, ...subpath] = specifier.split('/');
      const pkg = `${scope}/${name}`;
      const base = workspacePackages.get(pkg);
      return {
        kind: 'package',
        pkg,
        target:
          base === undefined
            ? specifier
            : subpath.length > 0
              ? `${base}/${subpath.join('/')}`
              : base,
      };
    }
    return { kind: 'other', target: specifier };
  };

  const isModuleRendererSide = (file) =>
    /^modules\/[^/]+\/(ui|settings|contracts)\//.test(file) ||
    /^modules\/[^/]+\/contracts\.ts$/.test(file);
  const isOwnRuntimeTarget = (owner, target) =>
    target === `modules/${owner}/runtime` || target.startsWith(`modules/${owner}/runtime/`);

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!/\.(?:ts|tsx|mjs)$/.test(entry.name) || entry.name.endsWith('.d.mts')) continue;
      const file = toRepoPath(path);
      const source = await readFile(path, 'utf8');
      const inModule = file.startsWith('modules/');
      const owner = inModule ? file.split('/')[1] : undefined;
      const isTest = file.includes('/test/');
      // renderer 侧代码：宿主 renderer、模块 UI/设置/契约（目录与根文件 contracts.ts 都算）、共享 UI 包。
      // 模块 runtime/storage 是主进程运行层；模块 domain 是纯领域逻辑，ui 与 runtime 皆可依赖。
      const renderer =
        file.startsWith('apps/desktop/src/renderer/') ||
        file.startsWith('packages/ui/') ||
        isModuleRendererSide(file);

      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        const { kind, target, pkg } = resolveTarget(dirname(path), specifier);

        // renderer 侧不得依赖平台模块（组合根与 preload 桥接类型除外）
        if (
          renderer &&
          (specifier.startsWith('node:') ||
            specifier === 'electron' ||
            builtinModules.includes(specifier))
        )
          violations.push(`${file}: renderer imports platform module ${specifier}`);
        // renderer 侧不得触碰主进程/preload 代码（相对路径与包名形式都拦）
        if (
          renderer &&
          (target.startsWith('apps/desktop/src/main/') ||
            target.startsWith('apps/desktop/src/preload/'))
        )
          violations.push(`${file}: renderer imports main/preload process code ${specifier}`);

        // 共享包不得依赖业务模块
        if (
          file.startsWith('packages/') &&
          (target.startsWith('modules/') ||
            (pkg?.startsWith('@reisa/module-') && pkg !== '@reisa/module-sdk'))
        )
          violations.push(
            `${file}: foundation/shared package imports business module ${specifier}`,
          );

        // 宿主 renderer 只能经组合根取模块贡献
        if (
          file.startsWith('apps/desktop/src/renderer/') &&
          pkg?.startsWith('@reisa/') &&
          pkg !== '@reisa/module-sdk' &&
          pkg !== '@reisa/ui'
        )
          violations.push(
            `${file}: host renderer must use the composition root for module contributions`,
          );

        if (inModule) {
          // 模块依赖白名单：工作区包只允许 SDK 与共享 UI 包（测试另允许 module-host 做端到端装配），
          // 自身包引用放行——agent-adapter、foundation 等其余 @reisa/ 包一律禁止
          if (pkg?.startsWith('@reisa/')) {
            const allowed = isTest
              ? ['@reisa/module-sdk', '@reisa/module-host', '@reisa/ui']
              : ['@reisa/module-sdk', '@reisa/ui'];
            if (!allowed.includes(pkg) && pkg !== `@reisa/module-${owner}`)
              violations.push(`${file}: module dependency outside the allowlist ${specifier}`);
          }
          // 相对路径形式的跨模块导入
          if (
            kind === 'file' &&
            target.startsWith('modules/') &&
            !target.startsWith(`modules/${owner}/`)
          )
            violations.push(`${file}: cross-module import ${specifier}`);
          // 模块 renderer 侧（ui/settings/contracts）不得导入自身 runtime（相对路径或包名形式都拦）
          if (isModuleRendererSide(file) && isOwnRuntimeTarget(owner, target))
            violations.push(`${file}: module renderer side imports own runtime ${specifier}`);
        }

        if (PRIVATE_SUBPATH_PATTERN.test(specifier))
          violations.push(`${file}: private package subpath ${specifier}`);
        const isRuntimeEntry =
          file.startsWith('apps/desktop/src/composition/') && RUNTIME_ENTRY_PATTERN.test(specifier);
        if (RUNTIME_ENTRY_PATTERN.test(specifier) && !isRuntimeEntry)
          violations.push(`${file}: runtime entry may only be imported by the composition root`);
      }
    }
  }

  for (const directory of ['apps', 'packages', 'modules']) {
    const base = join(rootDir, directory);
    if (existsSync(base)) await visit(base);
  }
  return violations;
}

// CLI 入口（被测试导入时只导出 checkBoundaries，不执行）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = await checkBoundaries(root);
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'Package boundaries passed: renderer/platform, composition root, shared packages, and module isolation.',
    );
}

/**
 * 边界检查回归测试（R7）：检查器必须按实际导入目标判定，
 * 四类历史漏检（renderer→main 相对路径、模块 ui→自身 runtime、根 contracts.ts 引平台模块、
 * 模块引入白名单外 @reisa/ 包）各自被反例夹具拦下，合法夹具放行，当前仓库保持全绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkBoundaries } from '../scripts/check-boundaries.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

/** 在临时目录里构造夹具文件（路径 → 内容），返回夹具根目录。 */
async function makeFixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'reisa-boundaries-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function assertViolation(files, expectedFragment) {
  const violations = await checkBoundaries(await makeFixture(files));
  assert.ok(
    violations.some((line) => line.includes(expectedFragment)),
    `应检出违规 ${expectedFragment}，实际：${JSON.stringify(violations)}`,
  );
}

test('当前仓库无边界违规', async () => {
  assert.deepEqual(await checkBoundaries(repoRoot), []);
});

test('反例 1：宿主 renderer 经相对路径导入 main 进程代码被拦', async () => {
  await assertViolation(
    {
      'apps/desktop/src/renderer/shell/A.tsx':
        "import { loadEnabled } from '../../main/enabled-modules.ts';\nexport const x = loadEnabled;\n",
    },
    'renderer imports main/preload process code',
  );
});

test('反例 1b：宿主 renderer 经相对路径导入 preload 被拦', async () => {
  await assertViolation(
    {
      'apps/desktop/src/renderer/bridge.ts':
        "import { expose } from '../preload/index.ts';\nexport const x = expose;\n",
    },
    'renderer imports main/preload process code',
  );
});

test('反例 2：模块 ui 经相对路径导入自身 runtime 被拦', async () => {
  await assertViolation(
    {
      'modules/demo/ui/A.tsx':
        "import { parse } from '../runtime/parse.ts';\nexport const x = parse;\n",
    },
    'module renderer side imports own runtime',
  );
});

test('反例 2b：模块 ui 经包名子路径导入自身 runtime 被拦', async () => {
  await assertViolation(
    {
      'modules/demo/ui/A.tsx':
        "import { parse } from '@reisa/module-demo/runtime';\nexport const x = parse;\n",
    },
    'runtime entry may only be imported by the composition root',
  );
});

test('反例 3：模块根 contracts.ts 导入平台模块被拦（根文件形式也算 renderer 侧）', async () => {
  await assertViolation(
    {
      'modules/demo/contracts.ts': "import { join } from 'node:path';\nexport const p = join;\n",
    },
    'renderer imports platform module',
  );
});

test('反例 3b：模块 contracts/ 目录形式导入平台模块被拦（既有规则保持）', async () => {
  await assertViolation(
    {
      'modules/demo/contracts/x.ts': "import { join } from 'node:path';\nexport const p = join;\n",
    },
    'renderer imports platform module',
  );
});

test('反例 4：模块 runtime 导入白名单外的 @reisa/ 包（agent-adapter）被拦', async () => {
  await assertViolation(
    {
      'modules/demo/runtime/index.ts':
        "import { something } from '@reisa/agent-adapter';\nexport const x = something;\n",
    },
    'module dependency outside the allowlist',
  );
});

test('反例 4b：模块 ui 导入 @reisa/foundation 同样被拦（白名单约束整个模块）', async () => {
  await assertViolation(
    {
      'modules/demo/ui/A.tsx': "import { log } from '@reisa/foundation';\nexport const x = log;\n",
    },
    'module dependency outside the allowlist',
  );
});

test('合法夹具：现行全部合法依赖关系保持通过', async () => {
  const violations = await checkBoundaries(
    await makeFixture({
      // 模块自身：ui → contracts/domain、runtime → node: 与 contracts、包自引用白名单
      'modules/demo/contracts.ts': "export const MODULE_ID = 'demo';\n",
      'modules/demo/domain/util.ts': 'export const norm = (v: string) => v.trim();\n',
      'modules/demo/ui/A.tsx':
        "import { MODULE_ID } from '../contracts.ts';\nimport { norm } from '../domain/util.ts';\nimport { Button } from '@reisa/ui';\nimport { defineCapability } from '@reisa/module-sdk';\nexport const view = MODULE_ID + norm('x') + Button + defineCapability;\n",
      'modules/demo/runtime/index.ts':
        "import { join } from 'node:path';\nimport { MODULE_ID } from '../contracts.ts';\nexport const id = join(MODULE_ID);\n",
      // 组合根：runtime 入口唯一合法导入方
      'apps/desktop/src/composition/modules.ts':
        "import { id } from '@reisa/module-demo/runtime';\nexport const m = id;\n",
      // 宿主 renderer：组合根与共享 UI 包
      'apps/desktop/src/renderer/shell/B.tsx':
        "import { m } from '../../composition/modules.ts';\nimport { Button } from '@reisa/ui';\nimport type { ModuleContribution } from '@reisa/module-sdk';\nexport const v: ModuleContribution[] = [m, Button] as never;\n",
      // 模块测试：允许 module-host 与 node:test
      'modules/demo/test/a.test.mjs':
        "import test from 'node:test';\nimport { ModuleHost } from '@reisa/module-host';\ntest('装配', () => {});\n",
    }),
  );
  assert.deepEqual(violations, []);
});

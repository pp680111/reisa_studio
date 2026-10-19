/**
 * 注册表与运行时端到端测试：真实 ModuleHost 装配 repo-explorer 模块，验证
 * 能力注册、页面服务增删改、持久化、启停对 Agent 工具可见性的影响与沙箱拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleHost } from '@reisa/module-host';
import { createRepoExplorerRuntime } from '../runtime/index.ts';

const invocation = (invocationId) => ({ invocationId, signal: new AbortController().signal });

/**
 * 文件版模块配置服务（模拟 foundation createNodeModuleServices 的持久化语义，
 * 不直接依赖 foundation——边界规则禁止模块测试引入它）。
 */
function makeFileServices(storageRoot) {
  return async (moduleId) => {
    const moduleDir = join(storageRoot, moduleId);
    await mkdir(moduleDir, { recursive: true });
    const settingsPath = join(moduleDir, 'settings.json');
    let cache;
    const load = async () => {
      if (cache !== undefined) return cache;
      try {
        cache = JSON.parse(await readFile(settingsPath, 'utf8'));
      } catch {
        cache = {};
      }
      return cache;
    };
    return {
      storage: { dataDir: moduleDir },
      config: {
        get: async (key) => (await load())[key],
        set: async (key, value) => {
          const data = await load();
          data[key] = value;
          await writeFile(settingsPath, JSON.stringify(data));
        },
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
  };
}

/** 建一个最小 fixture 仓库目录。 */
async function makeFixtureRepo(label) {
  const root = await mkdtemp(join(tmpdir(), `re-fixture-${label}-`));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export const hello = "world";\n');
  return root;
}

async function makeHost() {
  const storage = await mkdtemp(join(tmpdir(), 're-runtime-'));
  // 与生产组合根同语义：文件配置服务，保证注册表持久化
  const host = new ModuleHost({ storageRoot: storage, servicesFactory: makeFileServices(storage) });
  let pageService;
  const runtime = createRepoExplorerRuntime({
    registerPageService: (invoke) => {
      pageService = invoke;
    },
  });
  host.register(runtime);
  await host.activate('repo-explorer');
  return {
    host,
    page: async (action, input) => pageService(action, input ?? {}),
    cleanup: async () => {
      await host.deactivate('repo-explorer').catch(() => {});
      await rm(storage, { recursive: true, force: true });
    },
  };
}

test('激活后五个能力全部注册，模块 active', async () => {
  const { host, cleanup } = await makeHost();
  try {
    assert.equal(host.getState('repo-explorer'), 'active');
    assert.deepEqual(
      host
        .listEnabledCapabilities()
        .map((capability) => capability.id)
        .sort(),
      [
        'repo-explorer/glob',
        'repo-explorer/grep',
        'repo-explorer/list_repos',
        'repo-explorer/ls',
        'repo-explorer/read_file',
      ],
    );
  } finally {
    await cleanup();
  }
});

test('空注册表：list_repos 返回空数组，沙箱拒绝任何仓库路径', async () => {
  const { host, cleanup } = await makeHost();
  try {
    const repos = await host.invoke('repo-explorer/list_repos', {}, invocation('i1'));
    assert.equal(repos.status, 'success');
    assert.deepEqual(repos.value, { repos: [] });

    const denied = await host.invoke('repo-explorer/ls', { path: '/repos/demo/' }, invocation('i2'));
    assert.equal(denied.status, 'error');
    assert.equal(denied.error?.code, 'RESOURCE_NOT_FOUND');
  } finally {
    await cleanup();
  }
});

test('页面服务登记仓库后工具立即可见；重复名与非法名被拒绝', async () => {
  const { host, page, cleanup } = await makeHost();
  const fixture = await makeFixtureRepo('add');
  try {
    const added = await page('add_repo', {
      name: 'demo',
      path: fixture,
      tags: ['全连接', 'ush'],
      description: '演示仓库',
    });
    assert.equal(added.name, 'demo');
    assert.deepEqual(added.tags, ['全连接', 'ush']);

    const repos = await host.invoke('repo-explorer/list_repos', {}, invocation('i3'));
    assert.deepEqual(repos.value, {
      repos: [{ name: 'demo', path: '/repos/demo/', tags: ['全连接', 'ush'], description: '演示仓库' }],
    });

    await assert.rejects(() => page('add_repo', { name: 'demo', path: fixture }), /已存在/);
    await assert.rejects(() => page('add_repo', { name: '../evil', path: fixture }), /不合法/);
    await assert.rejects(() => page('add_repo', { name: 'rel', path: 'relative/path' }), /绝对目录/);
  } finally {
    await cleanup();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('ls / read_file / glob / grep 全链路（虚拟路径输出）', async () => {
  const { host, page, cleanup } = await makeHost();
  const fixture = await makeFixtureRepo('e2e');
  await page('add_repo', { name: 'demo', path: fixture });
  try {
    const ls = await host.invoke('repo-explorer/ls', { path: '/repos/demo/' }, invocation('i4'));
    assert.equal(ls.status, 'success');
    assert.deepEqual(
      ls.value.entries.map((entry) => entry.name),
      ['src'],
    );

    const read = await host.invoke(
      'repo-explorer/read_file',
      { path: '/repos/demo/src/main.ts' },
      invocation('i5'),
    );
    assert.equal(read.status, 'success');
    assert.equal(read.value.content, 'export const hello = "world";');
    assert.equal(read.value.startLine, 1);
    assert.equal(read.value.endLine, 1);
    assert.equal(read.value.truncated, false);

    const glob = await host.invoke(
      'repo-explorer/glob',
      { pattern: '**/*.ts', path: '/repos/demo/' },
      invocation('i6'),
    );
    assert.deepEqual(glob.value, { matches: ['/repos/demo/src/main.ts'], truncated: false });

    const grep = await host.invoke(
      'repo-explorer/grep',
      { pattern: 'hello', path: '/repos/demo/' },
      invocation('i7'),
    );
    assert.equal(grep.status, 'success');
    assert.deepEqual(grep.value, {
      matches: [{ path: '/repos/demo/src/main.ts', line: 1, snippet: 'export const hello = "world";' }],
      truncated: false,
      filesSearched: 1,
    });
  } finally {
    await cleanup();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('沙箱拒绝面：非法路径 INVALID_INPUT，越界仓库 RESOURCE_NOT_FOUND', async () => {
  const { host, page, cleanup } = await makeHost();
  const fixture = await makeFixtureRepo('sandbox');
  await page('add_repo', { name: 'demo', path: fixture });
  try {
    for (const bad of ['.', '/', '', '/repos/other/x', '/repos/demo/../../etc', 'C:/tmp']) {
      const result = await host.invoke('repo-explorer/ls', { path: bad }, invocation('i8'));
      assert.equal(result.status, 'error', `应拒绝：${bad}`);
      assert.ok(
        result.error?.code === 'INVALID_INPUT' || result.error?.code === 'RESOURCE_NOT_FOUND',
        `错误码意外：${result.error?.code}`,
      );
    }
    const missing = await host.invoke(
      'repo-explorer/read_file',
      { path: '/repos/demo/no/such.txt' },
      invocation('i9'),
    );
    assert.equal(missing.error?.code, 'RESOURCE_NOT_FOUND');
  } finally {
    await cleanup();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('停用仓库后工具不可见；重新启用恢复', async () => {
  const { host, page, cleanup } = await makeHost();
  const fixture = await makeFixtureRepo('toggle');
  await page('add_repo', { name: 'demo', path: fixture });
  try {
    const id = (await page('list_repos'))[0]?.id;
    await page('update_repo', { id, enabled: false });

    const repos = await host.invoke('repo-explorer/list_repos', {}, invocation('i10'));
    assert.deepEqual(repos.value.repos, []);

    const denied = await host.invoke('repo-explorer/ls', { path: '/repos/demo/' }, invocation('i11'));
    assert.equal(denied.error?.code, 'RESOURCE_NOT_FOUND');

    await page('update_repo', { id, enabled: true });
    const restored = await host.invoke('repo-explorer/ls', { path: '/repos/demo/' }, invocation('i12'));
    assert.equal(restored.status, 'success');
  } finally {
    await cleanup();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('注册表持久化：同 storageRoot 重建运行时后仓库仍在', async () => {
  const storage = await mkdtemp(join(tmpdir(), 're-persist-'));
  const fixture = await makeFixtureRepo('persist');
  const services = makeFileServices(storage);
  try {
    {
      const host = new ModuleHost({ storageRoot: storage, servicesFactory: services });
      let page;
      host.register(
        createRepoExplorerRuntime({
          registerPageService: (invoke) => {
            page = invoke;
          },
        }),
      );
      await host.activate('repo-explorer');
      await page('add_repo', { name: 'kept', path: fixture });
      await host.deactivate('repo-explorer');
    }
    {
      const host = new ModuleHost({ storageRoot: storage, servicesFactory: services });
      host.register(createRepoExplorerRuntime({}));
      await host.activate('repo-explorer');
      const repos = await host.invoke('repo-explorer/list_repos', {}, invocation('i13'));
      assert.deepEqual(repos.value, {
        repos: [{ name: 'kept', path: '/repos/kept/', tags: [], description: null }],
      });
      await host.deactivate('repo-explorer');
    }
  } finally {
    await rm(storage, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test('remove_repo 后工具不再可见', async () => {
  const { host, page, cleanup } = await makeHost();
  const fixture = await makeFixtureRepo('remove');
  await page('add_repo', { name: 'demo', path: fixture });
  try {
    const id = (await page('list_repos'))[0]?.id;
    const removed = await page('remove_repo', { id });
    assert.equal(removed.removed, 'demo');
    const repos = await host.invoke('repo-explorer/list_repos', {}, invocation('i14'));
    assert.deepEqual(repos.value.repos, []);
  } finally {
    await cleanup();
    await rm(fixture, { recursive: true, force: true });
  }
});

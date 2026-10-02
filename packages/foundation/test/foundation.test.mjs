/** foundation 行为测试：布局、文件配置、凭据存储、模块作用域服务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appDataLayout,
  createFileConfigService,
  createFileCredentialStore,
  createNodeModuleServices,
} from '../src/index.ts';

async function tmpDir() {
  return mkdtemp(join(tmpdir(), 'reisa-foundation-'));
}

test('app-data 布局符合架构设计 §7.2', () => {
  const layout = appDataLayout(join('data', 'app-data'));
  assert.equal(layout.foundationDir, join('data', 'app-data', 'foundation'));
  assert.equal(layout.conversationsDb, join('data', 'app-data', 'main', 'conversations.sqlite'));
  assert.equal(layout.moduleDir('knowledge'), join('data', 'app-data', 'modules', 'knowledge'));
});

test('文件配置：写入后可读、可重载、落盘为合法 JSON', async () => {
  const root = await tmpDir();
  const filePath = join(root, 'foundation', 'settings.json');
  const config = await createFileConfigService(filePath);

  await config.set('theme', 'dark');
  await config.set('providerConnections', { default: { baseURL: 'https://api.example.com' } });
  assert.equal(await config.get('theme'), 'dark');

  const reloaded = await createFileConfigService(filePath);
  assert.equal(await reloaded.get('theme'), 'dark', '重新打开后配置仍在');
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.providerConnections.default.baseURL, 'https://api.example.com');

  await reloaded.remove('theme');
  assert.equal(await reloaded.get('theme'), undefined);
});

test('凭据存储：引用名读写删除，加密器生效', async () => {
  const root = await tmpDir();
  const filePath = join(root, 'foundation', 'credentials.json');
  const calls = [];
  const cipher = {
    encrypt: (plain) => {
      calls.push('encrypt');
      return `enc:${Buffer.from(plain).toString('base64')}`;
    },
    decrypt: (payload) => Buffer.from(payload.slice(4), 'base64').toString('utf8'),
  };
  const store = createFileCredentialStore(filePath, cipher);
  await store.set('provider.default.apiKey', 'sk-test');
  assert.equal(await store.get('provider.default.apiKey'), 'sk-test');
  assert.deepEqual(calls, ['encrypt'], '读取路径必须解密');
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.notEqual(raw['provider.default.apiKey'], 'sk-test', '落盘内容不能是明文');

  await store.remove('provider.default.apiKey');
  assert.equal(await store.get('provider.default.apiKey'), undefined);
});

test('模块作用域服务：目录创建、settings.json 持久化、作用域隔离', async () => {
  const root = await tmpDir();
  const knowledge = await createNodeModuleServices(join(root, 'modules'), 'knowledge');
  const image = await createNodeModuleServices(join(root, 'modules'), 'image');

  await knowledge.config.set('retrieval', 'local');
  assert.equal(await knowledge.config.get('retrieval'), 'local');
  assert.equal(await image.config.get('retrieval'), undefined, '另一模块读不到该配置');

  const entries = await readdir(join(root, 'modules', 'knowledge'));
  assert.ok(entries.includes('settings.json'));
  assert.ok(entries.includes('files'));
  assert.equal(knowledge.storage.dataDir, join(root, 'modules', 'knowledge'));
});

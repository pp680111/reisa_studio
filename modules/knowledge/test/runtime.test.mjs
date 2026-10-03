/**
 * 运行时端到端测试：真实 ModuleHost 装配知识库模块，验证
 * 能力注册（TypeBox 校验）、能力调用、页面服务通道与停用语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { ModuleHost } from '@reisa/module-host';
import { createKnowledgeRuntime } from '../runtime/index.ts';

const invocation = (invocationId) => ({ invocationId, signal: new AbortController().signal });

async function waitFor(predicate, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), 'kb-runtime-'));
  const host = new ModuleHost({ storageRoot: root });
  let pageService;
  const runtime = createKnowledgeRuntime({
    registerPageService: (invoke) => {
      pageService = invoke;
    },
  });
  host.register(runtime);
  await host.activate('knowledge');
  return {
    host,
    pageService: () => pageService,
    cleanup: async () => {
      await host.deactivate('knowledge').catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('激活后四个能力全部注册，模块 active', async () => {
  const { host, cleanup } = await makeHost();
  try {
    assert.equal(host.getState('knowledge'), 'active');
    assert.deepEqual(
      host
        .listEnabledCapabilities()
        .map((capability) => capability.id)
        .sort(),
      [
        'knowledge/list_documents',
        'knowledge/read_document',
        'knowledge/search',
        'knowledge/upload_document',
      ],
    );
  } finally {
    await cleanup();
  }
});

test('knowledge/search：空库检索走降级路径返回空结果（未配置 embedding）', async () => {
  const { host, cleanup } = await makeHost();
  try {
    const result = await host.invoke('knowledge/search', { query: '任何词' }, invocation('inv-1'));
    assert.equal(result.status, 'success');
    assert.deepEqual(result.value, {
      query: '任何词',
      mode: 'full_text',
      degraded: true,
      results: [],
    });
  } finally {
    await cleanup();
  }
});

test('knowledge/search：输入不符声明返回 INVALID_INPUT', async () => {
  const { host, cleanup } = await makeHost();
  try {
    const empty = await host.invoke('knowledge/search', { query: '' }, invocation('inv-2'));
    assert.equal(empty.status, 'error');
    assert.equal(empty.error?.code, 'INVALID_INPUT');

    const missing = await host.invoke('knowledge/search', {}, invocation('inv-3'));
    assert.equal(missing.status, 'error');
    assert.equal(missing.error?.code, 'INVALID_INPUT');
  } finally {
    await cleanup();
  }
});

test('knowledge/upload_document + list_documents + read_document 全链路', async () => {
  const { host, cleanup } = await makeHost();
  try {
    const upload = await host.invoke(
      'knowledge/upload_document',
      { filename: 'notes.md', content: '# 标题\n\n上传的内容正文，用于检索验证 zebra。' },
      invocation('inv-4'),
    );
    assert.equal(upload.status, 'success');
    assert.equal(upload.value?.status, 'queued');

    // 上传唤醒后台循环（防抖后对账）：轮询等待文档出现
    const appeared = await waitFor(async () => {
      const listed = await host.invoke(
        'knowledge/list_documents',
        { limit: 10 },
        invocation('inv-poll'),
      );
      return listed.status === 'success' && listed.value?.total === 1 ? listed : false;
    });
    assert.ok(appeared, '上传的文档应在防抖后被后台循环索引');

    const listed = await host.invoke(
      'knowledge/list_documents',
      { limit: 10 },
      invocation('inv-5'),
    );
    assert.equal(listed.value?.total, 1);
    assert.equal(listed.value?.items[0]?.name, 'notes.md');
    assert.match(listed.value?.items[0]?.error ?? '', /not configured/);

    const documentId = listed.value?.items[0]?.id;
    const read = await host.invoke('knowledge/read_document', { documentId }, invocation('inv-6'));
    assert.equal(read.status, 'success');
    assert.equal(read.value?.id, documentId);
    assert.ok(read.value?.content.includes('上传的内容正文'));
    assert.equal(read.value?.contentTrusted, false, '正文恒标记为不可信数据');
    assert.equal(read.value?.truncated, false);

    // 停用后能力不可用（CAPABILITY_UNAVAILABLE），数据保留
    await host.deactivate('knowledge');
    const after = await host.invoke('knowledge/search', { query: 'zebra' }, invocation('inv-7'));
    assert.equal(after.status, 'error');
    assert.equal(after.error?.code, 'CAPABILITY_UNAVAILABLE');
  } finally {
    await cleanup();
  }
});

test('页面服务：来源管理与配置读写，未授权操作被拒', async () => {
  const { pageService, cleanup } = await makeHost();
  try {
    const service = pageService();
    assert.ok(service, '页面服务应已注册');

    const sources = await service('list_sources', {});
    assert.ok(Array.isArray(sources));
    assert.ok(sources.length >= 1, 'uploads 内置来源应自动注册');

    const status = await service('get_sync_status', {});
    assert.equal(status.running, false);
    assert.ok(typeof status.runs === 'number');

    // scan_now 唤醒对账：轮询等待 runs 增长
    await service('scan_now', {});
    assert.ok(
      await waitFor(async () => (await service('get_sync_status', {})).runs >= 1),
      'scan_now 后应执行一轮对账',
    );

    const stats = await service('get_stats', {});
    assert.ok(typeof stats.documents === 'number');

    const config = await service('get_config', {});
    assert.equal(config.embedding.dimensions, 1024, '默认维度 1024');
    assert.equal(config.syncIntervalSeconds, 600);

    const updated = await service('update_config', {
      settings: { ...config, syncIntervalSeconds: 120 },
    });
    assert.equal(updated.syncIntervalSeconds, 120);
    const reread = await service('get_config', {});
    assert.equal(reread.syncIntervalSeconds, 120);

    await assert.rejects(() => service('unknown_action', {}), /未知的页面服务操作/);
  } finally {
    await cleanup();
  }
});

test('update_config 变更 embedding 指纹 → 清空文档重建、保留 sources（重配置路径）', async () => {
  const { pageService, cleanup } = await makeHost();
  try {
    const service = pageService();
    await service('upload_file', { filename: 'rebuild.md', content: '# 标题\n\n待重建内容' });
    assert.ok(
      await waitFor(async () => (await service('list_documents', {})).total >= 1),
      '上传文档应先被记录',
    );

    const config = await service('get_config', {});
    const updated = await service('update_config', {
      settings: {
        ...config,
        embedding: { ...config.embedding, dimensions: config.embedding.dimensions + 1 },
      },
    });
    // 指纹变更：文档记录清空（对应 skb 全量重建），sources 保留
    assert.equal(updated.embedding.dimensions, config.embedding.dimensions + 1);
    assert.equal((await service('list_documents', {})).total, 0);
    assert.ok((await service('list_sources', {})).length >= 1, 'sources 保留');
    // 重配置后页面服务仍可用
    assert.ok(typeof (await service('get_sync_status', {})).runs === 'number');
  } finally {
    await cleanup();
  }
});

test('输出 Schema 校验：结果不符声明报 EXECUTION_FAILED', async () => {
  // 用一个声明了严格输出 Schema 的内联模块验证宿主行为（与 e2e-chain 同模式）
  const root = await mkdtemp(join(tmpdir(), 'kb-schema-'));
  const host = new ModuleHost({ storageRoot: root });
  host.register({
    id: 'fake',
    version: '0.1.0',
    protocolVersion: '1',
    async activate() {
      return {
        tools: [
          {
            definition: {
              id: 'fake/echo',
              name: 'fake__echo',
              version: '0.1.0',
              description: 'schema 校验测试',
              inputSchema: Type.Object({ v: Type.String() }),
              outputSchema: Type.Object({ out: Type.String() }),
            },
            execute: async () => ({ status: 'success', value: { wrong: true } }),
          },
        ],
        deactivate: async () => {},
      };
    },
  });
  await host.activate('fake');
  const result = await host.invoke('fake/echo', { v: 'x' }, invocation('inv-8'));
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'EXECUTION_FAILED');
  await host.deactivate('fake');
  await rm(root, { recursive: true, force: true });
});

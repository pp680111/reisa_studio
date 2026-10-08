/**
 * 运行时端到端测试：真实 ModuleHost 装配知识库模块，验证
 * 能力注册（TypeBox 校验）、能力调用、页面服务通道与停用语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Type } from '@sinclair/typebox';
import { ModuleHost } from '@reisa/module-host';
import { createKnowledgeRuntime, toDocumentInfo } from '../runtime/index.ts';
import { MetadataDB } from '../runtime/db.ts';
import { ChunkStore } from '../runtime/store.ts';

const invocation = (invocationId) => ({ invocationId, signal: new AbortController().signal });

async function waitFor(predicate, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 断言元数据库连接已关闭（关闭后任何查询都会抛错）。 */
function assertClosed(database, message) {
  assert.throws(() => database.listSources(), /open|closed/i, message);
}

/** 断言元数据库连接仍打开且可查询。 */
function assertOpen(database, message) {
  assert.ok(Array.isArray(database.listSources()), message);
}

async function makeHost(runtimeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kb-runtime-'));
  const host = new ModuleHost({ storageRoot: root });
  let pageService;
  const runtime = createKnowledgeRuntime({
    registerPageService: (invoke) => {
      pageService = invoke;
    },
    ...runtimeOptions,
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

test('页面服务 test_connection：草稿实测 embedding 服务（成功 / 认证失败 / 维度不符 / 未配置）', async () => {
  const { pageService, cleanup } = await makeHost();
  let server;
  try {
    const service = pageService();

    // 未配置任何 embedding 信息时直接提示，不发起请求
    const missing = await service('test_connection', {});
    assert.equal(missing.ok, false);
    assert.match(missing.error, /请先填写/);

    // 本地假 OpenAI 兼容 embeddings 服务：sk-good 正常返回 4 维向量，其余 401
    let lastRequest = null;
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        lastRequest = {
          url: request.url,
          auth: request.headers.authorization,
          body: JSON.parse(body),
        };
        response.setHeader('content-type', 'application/json');
        if (request.headers.authorization !== 'Bearer sk-good') {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        response.end(
          JSON.stringify({
            data: [{ index: 0, embedding: [1, 2, 3, 4] }],
            usage: { prompt_tokens: 3 },
          }),
        );
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

    // 成功：草稿配置直接生效（无需先保存），请求打到 /v1/embeddings 并携带测试文本
    const ok = await service('test_connection', {
      baseUrl,
      apiKey: 'sk-good',
      model: 'fake-embedding',
      dimensions: 4,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.model, 'fake-embedding');
    assert.equal(ok.dimensions, 4);
    assert.ok(typeof ok.latencyMs === 'number');
    assert.equal(lastRequest.url, '/v1/embeddings');
    assert.equal(lastRequest.auth, 'Bearer sk-good');
    assert.equal(lastRequest.body.model, 'fake-embedding');
    assert.deepEqual(lastRequest.body.input, ['连接测试']);

    // 认证失败：401 → 分类后的可读提示
    const denied = await service('test_connection', {
      baseUrl,
      apiKey: 'sk-bad',
      model: 'fake-embedding',
      dimensions: 4,
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /认证失败/);

    // 维度不符：服务返回 4 维、配置 5 维 → invalid_response 可读提示（含具体维度）
    const mismatched = await service('test_connection', {
      baseUrl,
      apiKey: 'sk-good',
      model: 'fake-embedding',
      dimensions: 5,
    });
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.error, /服务响应与配置不符/);
    assert.match(mismatched.error, /dimension 4, expected 5/);
  } finally {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
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

test('update_config 重配置失败：旧服务完整存活、模块保持 active、部分新资源已清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-rollback-'));
  const host = new ModuleHost({ storageRoot: root });
  let pageService;
  const databases = [];
  let failStoreOpen = false;
  const runtime = createKnowledgeRuntime({
    registerPageService: (invoke) => {
      pageService = invoke;
    },
    // 记录每次建库实例，用于观察新旧资源的关闭时序
    createDatabase: (path) => {
      const database = new MetadataDB(path);
      databases.push(database);
      return database;
    },
    // 首次激活走真实 LanceDB；重配置阶段注入打开失败
    openChunkStore: async (path, dimensions) => {
      if (failStoreOpen) throw new Error('向量库打开失败（注入）');
      return ChunkStore.open(path, dimensions);
    },
  });
  host.register(runtime);
  await host.activate('knowledge');
  try {
    assert.equal(databases.length, 1, '初始激活只建一次库');
    await pageService('upload_file', { filename: 'keep.md', content: '# 标题\n\n重配置后仍在' });
    assert.ok(
      await waitFor(async () => (await pageService('list_documents', {})).total >= 1),
      '上传文档应先被记录',
    );

    const config = await pageService('get_config', {});
    failStoreOpen = true;
    await assert.rejects(
      () => pageService('update_config', { settings: { ...config, syncIntervalSeconds: 90 } }),
      /向量库打开失败/,
      '设置页动作收到明确错误',
    );

    assert.equal(host.getState('knowledge'), 'active', '初始化失败后模块在宿主侧仍为 active');
    assert.equal((await pageService('get_config', {})).syncIntervalSeconds, 600, '运行时配置未变');

    // 旧服务完整存活：工具继续工作、旧库仍可查询、文档数据未丢
    const search = await host.invoke(
      'knowledge/search',
      { query: '重配置后仍在' },
      invocation('inv-rb'),
    );
    assert.equal(search.status, 'success');
    assert.equal((await pageService('list_documents', {})).total, 1);
    assertOpen(databases[0], '旧元数据库仍打开');

    // 部分建好的新元数据库已被清理（关闭）
    assert.equal(databases.length, 2, '重配置尝试建过一次新库');
    assertClosed(databases[1], '半成品新库已关闭');
  } finally {
    await host.deactivate('knowledge').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('update_config 重配置成功：旧资源释放、新配置生效、切换期间的工具调用正常完成', async () => {
  const databases = [];
  const { host, pageService, cleanup } = await makeHost({
    createDatabase: (path) => {
      const database = new MetadataDB(path);
      databases.push(database);
      return database;
    },
  });
  const service = pageService();
  try {
    await service('upload_file', { filename: 'swap.md', content: '# 标题\n\n切换期间检索' });
    assert.ok(
      await waitFor(async () => (await service('list_documents', {})).total >= 1),
      '上传文档应先被记录',
    );

    const config = await service('get_config', {});
    // 与重配置并发发起的工具调用：要么完整走旧服务、要么完整走新服务，都必须正常完成
    const [search, updated] = await Promise.all([
      host.invoke('knowledge/search', { query: '切换期间检索' }, invocation('inv-swap')),
      service('update_config', { settings: { ...config, syncIntervalSeconds: 45 } }),
    ]);
    assert.equal(search.status, 'success', '切换期间的工具调用不出现"未激活"类失败');
    assert.equal(updated.syncIntervalSeconds, 45, '重配置返回新配置');
    assert.equal((await service('get_config', {})).syncIntervalSeconds, 45, '新配置生效');

    // 切换完成后旧资源全部释放，新服务可用
    assert.ok(databases.length >= 2, '重配置建了新库');
    assertClosed(databases[0], '旧元数据库已释放');
    const after = await host.invoke(
      'knowledge/search',
      { query: '切换期间检索' },
      invocation('inv-after'),
    );
    assert.equal(after.status, 'success');
  } finally {
    await cleanup();
  }
});

test('重叠的 update_config 串行执行，返回值不交错', async () => {
  const { pageService, cleanup } = await makeHost();
  const service = pageService();
  try {
    const config = await service('get_config', {});
    const [first, second] = await Promise.all([
      service('update_config', { settings: { ...config, syncIntervalSeconds: 60 } }),
      service('update_config', { settings: { ...config, syncIntervalSeconds: 3600 } }),
    ]);
    assert.equal(first.syncIntervalSeconds, 60, '第一次保存返回其自身配置，未被第二次交错覆盖');
    assert.equal(second.syncIntervalSeconds, 3600);
    assert.equal(
      (await service('get_config', {})).syncIntervalSeconds,
      3600,
      '最终配置为最后一次保存',
    );
  } finally {
    await cleanup();
  }
});

test('toDocumentInfo 公开 DTO：error 字段不含绝对路径（含历史数据防御）', () => {
  const info = toDocumentInfo({
    id: 'doc-1',
    sourceId: 'src-1',
    relPath: 'secret.md',
    name: 'secret.md',
    contentHash: null,
    status: 'error',
    error: "ENOENT: no such file or directory, open 'C:\\Users\\zst\\secret.md'",
    chunkCount: 0,
    size: 10,
    mtimeNs: 0n,
    indexedAt: null,
  });
  assert.equal(info.status, 'error');
  assert.ok(!info.error.includes('C:'), '不含盘符');
  assert.ok(!info.error.includes('Users'), '不含目录段');
  assert.ok(!info.error.includes('\\'), '不含路径分隔符');
  assert.match(info.error, /secret\.md/, '保留错误类别与文件名');
  assert.deepEqual(
    toDocumentInfo({
      id: 'doc-2',
      sourceId: 'src-1',
      relPath: 'ok.md',
      name: 'ok.md',
      contentHash: null,
      status: 'indexed',
      error: null,
      chunkCount: 0,
      size: 0,
      mtimeNs: 0n,
      indexedAt: null,
    }),
    { id: 'doc-2', name: 'ok.md', status: 'indexed', error: null },
    '成功文档 error 保持 null',
  );
});

test('uploadMaxBytes 重配置后生效：页面上传与 Agent 工具两条入口共用同一校验', async () => {
  const { host, pageService, cleanup } = await makeHost();
  const service = pageService();
  try {
    const config = await service('get_config', {});
    await service('update_config', { settings: { ...config, uploadMaxBytes: 8 } });

    // 页面入口 upload_file：超限被拒（错误经页面桥接原样展示）
    await assert.rejects(
      () => service('upload_file', { filename: 'page.md', content: 'a'.repeat(10) }),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /超过大小上限/);
        assert.match(message, /10/);
        assert.match(message, /8/);
        return true;
      },
    );

    // Agent 工具入口 upload_document：同一 service.upload 校验同样拒绝，
    // upload_too_large 按既有 ServiceError 模式映射为 INVALID_INPUT
    const tool = await host.invoke(
      'knowledge/upload_document',
      { filename: 'agent.md', content: 'b'.repeat(10) },
      invocation('inv-big'),
    );
    assert.equal(tool.status, 'error');
    assert.equal(tool.error?.code, 'INVALID_INPUT');
    assert.match(tool.error?.message ?? '', /超过大小上限/);

    // 恰好等于上限放行（字节语义）
    const exact = await host.invoke(
      'knowledge/upload_document',
      { filename: 'exact.md', content: 'c'.repeat(8) },
      invocation('inv-exact'),
    );
    assert.equal(exact.status, 'success');
    assert.equal(exact.value?.status, 'queued');
  } finally {
    await cleanup();
  }
});

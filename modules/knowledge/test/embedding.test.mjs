/**
 * embedding 客户端测试（移植自 skb tests/unit/test_embedding.py 的核心用例）：
 * 错误分类重试、批量并发、整轮失败语义、响应校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingError, OpenAICompatibleEmbeddingClient } from '../runtime/embedding.ts';
import { fakeVector } from './fake-embedder.mjs';

const DIM = 16;

function fakeResponse(texts) {
  return {
    data: texts.map((text, index) => ({ index, embedding: fakeVector(text, DIM) })),
    usage: { prompt_tokens: texts.length * 3 },
  };
}

/** 可编程客户端：按脚本依次抛错或返回；空脚本默认返回成功响应。记录请求与取消选项。 */
function scriptedClient(script) {
  const attempts = [];
  let call = 0;
  return {
    attempts,
    embeddings: {
      async create(input, options) {
        attempts.push({ input, options, at: call });
        const step =
          script.length === 0
            ? {
                data: input.input.map((text, index) => ({
                  index,
                  embedding: fakeVector(text, DIM),
                })),
                usage: { prompt_tokens: input.input.length * 3 },
              }
            : script[Math.min(call, script.length - 1)];
        call += 1;
        if (step instanceof Error) throw step;
        return typeof step === 'function' ? step(input) : step;
      },
    },
  };
}

function sleeper() {
  const sleeps = [];
  const fn = async (seconds) => {
    sleeps.push(seconds);
  };
  fn.sleeps = sleeps;
  return fn;
}

const makeClient = (clientScript, options = {}) => {
  const client = scriptedClient(clientScript);
  const sleep = sleeper();
  const embedder = new OpenAICompatibleEmbeddingClient({
    apiKey: 'key',
    baseUrl: 'http://localhost:9/v1',
    model: 'm',
    dimensions: DIM,
    maxRetries: 4,
    client,
    sleep,
    ...options,
  });
  return { client, sleep, embedder };
};

test('成功批量：按 batch 切片并汇总 prompt tokens', async () => {
  const { embedder, client } = makeClient([]);
  const texts = Array.from({ length: 25 }, (_, i) => `text-${i}`);
  const batch = await embedder.embed(texts);
  assert.equal(batch.vectors.length, 25);
  assert.equal(batch.promptTokens, 75);
  assert.equal(client.attempts.length, 2, 'batchSize=20 → 两批');
});

test('空输入与非空校验', async () => {
  const { embedder } = makeClient([]);
  const empty = await embedder.embed([]);
  assert.deepEqual(empty, { vectors: [], promptTokens: 0 });
  await assert.rejects(() => embedder.embed(['ok', '  ']), /non-empty/);
});

test('401/403 立即失败且不可重试', async () => {
  const { embedder, sleep } = makeClient([Object.assign(new Error('nope'), { status: 401 })]);
  await assert.rejects(
    () => embedder.embed(['x']),
    (error) =>
      error instanceof EmbeddingError &&
      error.code === 'authentication_failed' &&
      error.retryable === false,
  );
  assert.equal(sleep.sleeps.length, 0);
});

test('429 按 rate_limit_retry_delay 退避并重试成功', async () => {
  const { embedder, sleep } = makeClient([
    Object.assign(new Error('slow down'), { status: 429 }),
    fakeResponse(['x']),
  ]);
  const batch = await embedder.embed(['x']);
  assert.equal(batch.vectors.length, 1);
  assert.equal(sleep.sleeps.length, 1);
  assert.equal(sleep.sleeps[0], 30.0);
});

test('429 退避不低于 retry-after 头', async () => {
  const headers = new Headers({ 'retry-after': '7' });
  const { embedder, sleep } = makeClient(
    [Object.assign(new Error('slow'), { status: 429, headers }), fakeResponse(['x'])],
    { rateLimitRetryDelaySeconds: 3 },
  );
  await embedder.embed(['x']);
  assert.equal(sleep.sleeps[0], 7);
});

test('超时错误可重试（指数退避）', async () => {
  const timeoutError = new Error('Request timed out.');
  timeoutError.name = 'TimeoutError';
  const { embedder, sleep } = makeClient([timeoutError, fakeResponse(['x'])]);
  await embedder.embed(['x']);
  assert.equal(sleep.sleeps.length, 1);
  assert.equal(sleep.sleeps[0], 0.25, 'attempt=0 → 0.25s');
});

test('500 按 provider_unavailable 重试；400 不可重试', async () => {
  const retryable = makeClient([
    Object.assign(new Error('boom'), { status: 500 }),
    fakeResponse(['x']),
  ]);
  await retryable.embedder.embed(['x']);
  assert.equal(retryable.sleep.sleeps.length, 1);

  const fatal = makeClient([Object.assign(new Error('bad'), { status: 400 })]);
  await assert.rejects(
    () => fatal.embedder.embed(['x']),
    (error) => error instanceof EmbeddingError && error.code === 'request_failed',
  );
});

test('重试次数用尽后抛出分类错误', async () => {
  const { embedder, sleep } = makeClient([Object.assign(new Error('boom'), { status: 503 })]);
  await assert.rejects(
    () => embedder.embed(['x']),
    (error) => error instanceof EmbeddingError && error.code === 'provider_unavailable',
  );
  assert.equal(sleep.sleeps.length, 4, 'maxRetries=4');
});

test('响应校验：数量不符 / 索引异常 / 维度不符', async () => {
  const wrongCount = makeClient([
    { data: [{ index: 0, embedding: fakeVector('x', DIM) }], usage: { prompt_tokens: 1 } },
  ]);
  await assert.rejects(() => wrongCount.embedder.embed(['x', 'y']), /1 vectors for 2 inputs/);

  const duplicateIndex = makeClient([
    {
      data: [
        { index: 0, embedding: fakeVector('x', DIM) },
        { index: 0, embedding: fakeVector('y', DIM) },
      ],
    },
  ]);
  await assert.rejects(() => duplicateIndex.embedder.embed(['x', 'y']), /duplicate/);

  const wrongDim = makeClient([{ data: [{ index: 0, embedding: fakeVector('x', 8) }] }]);
  await assert.rejects(() => wrongDim.embedder.embed(['x']), /dimension 8/);
});

test('任一批失败要等全部批次结束（skb 整轮失败语义）', async () => {
  let finishedSecond = false;
  const slow = {
    embeddings: {
      async create(input) {
        if (input.input[0] === 'fast-fail') {
          throw Object.assign(new Error('bad'), { status: 400 });
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        finishedSecond = true;
        return fakeResponse(input.input);
      },
    },
  };
  const sleep = sleeper();
  const embedder = new OpenAICompatibleEmbeddingClient({
    apiKey: 'k',
    baseUrl: 'http://localhost:9/v1',
    model: 'm',
    dimensions: DIM,
    maxRetries: 0,
    batchSize: 1,
    client: slow,
    sleep,
  });
  // 'fast-fail' 落在第一批，慢批在第二批：整轮仍要等慢批完成才抛
  await assert.rejects(() => embedder.embed(['fast-fail', 'slow-one']));
  assert.equal(finishedSecond, true, '失败批次不提前释放对账锁');
});

test('取消信号：已中止的调用不发起 SDK 请求', async () => {
  const { embedder, client } = makeClient([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => embedder.embed(['x'], { signal: controller.signal }));
  assert.equal(client.attempts.length, 0, '已取消的调用不产生任何请求（无副作用）');
});

test('取消信号：退避等待期间中止立即停止重试，SDK 请求透传信号', async () => {
  // 可中止的 sleep：等待期间收到 abort 即刻拒绝（模拟取消打断 30s 退避）
  const sleeps = [];
  const abortableSleep = (seconds, signal) =>
    new Promise((resolve, reject) => {
      sleeps.push(seconds);
      const onAbort = () => reject(new Error('wait aborted'));
      if (signal?.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  const { embedder, client } = makeClient(
    [Object.assign(new Error('slow down'), { status: 429 }), fakeResponse(['x'])],
    { sleep: abortableSleep },
  );
  const controller = new AbortController();
  const embedding = embedder.embed(['x'], { signal: controller.signal });

  // 第一发已发出且进入 429 退避
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.attempts.length, 1);
  assert.equal(client.attempts[0].options?.signal, controller.signal, 'SDK 请求收到取消信号');
  assert.deepEqual(sleeps, [30.0]);

  controller.abort();
  await assert.rejects(() => embedding);
  assert.equal(client.attempts.length, 1, '中止后不再发起重试请求');
});

// ---- 接口级调用遥测（onRequest；设计文档 knowledge-embedding-call-log.md）----

test('onRequest：批次拆分逐请求发出，items 随批次切片对齐', async () => {
  const events = [];
  const { embedder } = makeClient([], {
    onRequest: (event) => events.push(event),
    batchSize: 2,
  });
  const items = Array.from({ length: 3 }, (_, i) => ({ chunkId: `c${i}`, ordinal: i }));
  await embedder.embed(['t0', 't1', 't2'], {
    context: { documentId: 'doc-1', relPath: 'a.md', documentName: 'a.md', items },
  });
  assert.equal(events.length, 2, '3 条文本按 batchSize=2 拆两批');
  assert.equal(new Set(events.map((event) => event.roundId)).size, 1, '同一轮共享 roundId');
  assert.deepEqual(
    events.map((event) => event.batchIndex),
    [0, 1],
  );
  assert.deepEqual(events[0].texts, ['t0', 't1']);
  assert.deepEqual(events[1].texts, ['t2']);
  assert.deepEqual(events[0].items, [items[0], items[1]]);
  assert.deepEqual(events[1].items, [items[2]]);
  assert.equal(events[0].attempt, 0);
  assert.equal(events[0].status, 'success');
  assert.equal(events[0].tokenCount, 6);
  assert.equal(events[0].errorCode, null);
  assert.equal(events[0].model, 'm');
});

test('onRequest：context.items 与 texts 长度不符直接报错', async () => {
  const { embedder } = makeClient([], { batchSize: 2 });
  await assert.rejects(() =>
    embedder.embed(['t0', 't1'], { context: { documentId: 'd', items: [{ chunkId: 'x' }] } }),
  );
});

test('onRequest：每次重试独立成事件（failed 后 success），错误取分类文案', async () => {
  const events = [];
  const rateLimited = Object.assign(new Error('too many'), { status: 429 });
  const { embedder } = makeClient([rateLimited, fakeResponse(['x'])], {
    onRequest: (event) => events.push(event),
  });
  const batch = await embedder.embed(['x'], {
    context: { documentId: 'd', items: [{ chunkId: 'c' }] },
  });
  assert.equal(batch.vectors.length, 1);
  assert.equal(events.length, 2, '一次失败尝试 + 一次成功尝试');
  assert.deepEqual(
    events.map((event) => event.attempt),
    [0, 1],
  );
  assert.equal(events[0].status, 'failed');
  assert.equal(events[0].errorCode, 'rate_limited');
  assert.match(events[0].errorMessage ?? '', /429/);
  assert.equal(events[0].tokenCount, null);
  assert.equal(events[1].status, 'success');
  assert.equal(events[1].tokenCount, 3);
});

test('onRequest：无 context（如检索）也发出事件，由记录器按上下文过滤', async () => {
  const events = [];
  const { embedder } = makeClient([], { onRequest: (event) => events.push(event) });
  await embedder.embed(['query']);
  assert.equal(events.length, 1);
  assert.equal(events[0].items, undefined);
  assert.equal(events[0].context, undefined);
});

test('onRequest：重试耗尽时每次失败尝试都有事件，最终仍抛出', async () => {
  const events = [];
  const serverError = Object.assign(new Error('boom'), { status: 503 });
  const { embedder, sleep } = makeClient([serverError], {
    maxRetries: 2,
    onRequest: (event) => events.push(event),
  });
  await assert.rejects(() => embedder.embed(['x']));
  assert.equal(events.length, 3, '尝试 0/1/2 全部失败');
  assert.deepEqual(
    events.map((event) => event.attempt),
    [0, 1, 2],
  );
  assert.ok(
    events.every(
      (event) => event.status === 'failed' && event.errorCode === 'provider_unavailable',
    ),
  );
  assert.equal(sleep.sleeps.length, 2, '重试退避两次，最终失败不再等待');
});

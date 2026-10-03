/**
 * OpenAI 兼容 embedding 客户端（迁移自 skb embedding.py）。
 * 行为基准（迁移设计文档 §4.3）：批量 + 并发上限、错误分类重试退避、
 * 任一子批失败则整轮 raise（保证不提前释放对账锁）、响应按 index 校验重排。
 * 错误文案刻意不携带响应体与输入文本。
 */

export type EmbeddingErrorCode =
  | 'authentication_failed'
  | 'rate_limited'
  | 'timeout'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'request_failed';

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number | null;

  constructor(
    message: string,
    options: { code: EmbeddingErrorCode; retryable: boolean; statusCode?: number | null },
  ) {
    super(message);
    this.name = 'EmbeddingError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode ?? null;
  }
}

export interface EmbeddingBatch {
  readonly vectors: number[][];
  readonly promptTokens: number | null;
}

export interface Embedder {
  embed(texts: readonly string[]): Promise<EmbeddingBatch>;
}

interface EmbeddingResponse {
  readonly data: readonly { readonly index: number; readonly embedding: number[] }[];
  readonly usage?: { readonly prompt_tokens?: number };
}

/** 与 skb 的 OpenAICompatibleClient Protocol 对齐的最小接口，便于测试注入。 */
export interface EmbeddingsClientLike {
  embeddings: {
    create(input: {
      model: string;
      input: string[];
      dimensions: number;
      encoding_format: 'float';
    }): Promise<EmbeddingResponse>;
  };
  close?(): Promise<void> | void;
}

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export interface EmbeddingClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize?: number;
  readonly maxConcurrency?: number;
  readonly timeoutSeconds?: number;
  readonly maxRetries?: number;
  readonly rateLimitRetryDelaySeconds?: number;
  readonly client?: EmbeddingsClientLike;
  readonly sleep?: (seconds: number) => Promise<void>;
}

export class OpenAICompatibleEmbeddingClient implements Embedder {
  readonly #model: string;
  readonly #dimensions: number;
  readonly #batchSize: number;
  readonly #maxConcurrency: number;
  readonly #maxRetries: number;
  readonly #rateLimitRetryDelaySeconds: number;
  readonly #sleep: (seconds: number) => Promise<void>;
  #resolvedClient: EmbeddingsClientLike | undefined;
  readonly #clientProvider: () => Promise<EmbeddingsClientLike>;

  constructor(options: EmbeddingClientOptions) {
    if (!options.apiKey.trim()) throw new Error('A non-empty embedding API key is required');
    if (!options.baseUrl.trim() || !options.model.trim()) {
      throw new Error('A non-empty embedding base_url and model are required');
    }
    const batchSize = options.batchSize ?? 20;
    if (batchSize < 1 || batchSize > 20) {
      throw new Error('embedding batch_size must be between 1 and 20');
    }
    const rateLimitDelay = options.rateLimitRetryDelaySeconds ?? 30.0;
    if (rateLimitDelay < 0) {
      throw new Error('rate_limit_retry_delay_seconds must be non-negative');
    }
    this.#model = options.model;
    this.#dimensions = options.dimensions;
    this.#batchSize = batchSize;
    this.#maxConcurrency = options.maxConcurrency ?? 2;
    this.#maxRetries = options.maxRetries ?? 4;
    this.#rateLimitRetryDelaySeconds = rateLimitDelay;
    this.#sleep = options.sleep ?? sleep;
    const injected = options.client;
    this.#clientProvider =
      injected === undefined
        ? () =>
            createDefaultClient({
              apiKey: options.apiKey,
              baseUrl: options.baseUrl,
              timeoutSeconds: options.timeoutSeconds ?? 30.0,
            })
        : async () => injected;
  }

  async #getClient(): Promise<EmbeddingsClientLike> {
    this.#resolvedClient ??= await this.#clientProvider();
    return this.#resolvedClient;
  }

  async embed(texts: readonly string[]): Promise<EmbeddingBatch> {
    if (texts.length === 0) return { vectors: [], promptTokens: 0 };
    if (texts.some((text) => typeof text !== 'string' || !text.trim())) {
      throw new Error('Embedding inputs must be non-empty strings');
    }
    const batches: string[][] = [];
    for (let start = 0; start < texts.length; start += this.#batchSize) {
      batches.push(texts.slice(start, start + this.#batchSize) as string[]);
    }
    // 任一子批失败也要等所有批次（含排队与重试）结束后再抛出——
    // 保证失败批次不会提前释放对账锁（skb 语义，test_failed_round_waits…）
    const settled = await Promise.allSettled(batches.map((batch) => this.#embedBatch(batch)));
    const vectors: number[][] = [];
    let totalTokens = 0;
    let hasUsage = true;
    let firstError: unknown = undefined;
    for (const result of settled) {
      if (result.status === 'rejected') {
        firstError ??= result.reason;
        continue;
      }
      vectors.push(...result.value.vectors);
      if (result.value.promptTokens === null) hasUsage = false;
      else totalTokens += result.value.promptTokens;
    }
    if (firstError !== undefined) throw firstError;
    return { vectors, promptTokens: hasUsage ? totalTokens : null };
  }

  async aclose(): Promise<void> {
    await (await this.#getClient()).close?.();
  }

  async #embedBatch(
    batch: string[],
  ): Promise<{ vectors: number[][]; promptTokens: number | null }> {
    const client = await this.#getClient();
    const response = await this.#createWithRetry(client, batch);
    return {
      vectors: validatedVectors(response, batch.length, this.#dimensions),
      promptTokens: response.usage?.prompt_tokens ?? null,
    };
  }

  async #createWithRetry(
    client: EmbeddingsClientLike,
    batch: string[],
  ): Promise<EmbeddingResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.embeddings.create({
          model: this.#model,
          input: batch,
          dimensions: this.#dimensions,
          encoding_format: 'float',
        });
      } catch (rawError) {
        const error = classifyError(rawError);
        if (!error.retryable || attempt >= this.#maxRetries) throw error;
        const retryAfter = retryAfterSeconds(rawError);
        if (error.code === 'rate_limited') {
          // 429 反映滑动窗口配额；短退避在窗口饱和时只会浪费重试次数（skb 注释）
          await this.#sleep(Math.max(retryAfter ?? 0, this.#rateLimitRetryDelaySeconds));
        } else {
          const delay = retryAfter ?? 0.25 * 2 ** attempt;
          await this.#sleep(Math.min(delay, 300.0));
        }
      }
    }
  }
}

function classifyError(error: unknown): EmbeddingError {
  const status = (error as { status?: unknown } | null)?.status;
  const statusCode = typeof status === 'number' ? status : null;
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const isTimeout =
    statusCode === 408 ||
    name === 'TimeoutError' ||
    (typeof name === 'string' && /timeout|timed out/i.test(name)) ||
    /request timed out/i.test(message);
  if (statusCode === 401 || statusCode === 403) {
    return new EmbeddingError(
      `Embedding request failed (status=${statusCode}, code=authentication_failed)`,
      { code: 'authentication_failed', retryable: false, statusCode },
    );
  }
  if (statusCode === 429) {
    return new EmbeddingError(`Embedding request failed (status=429, code=rate_limited)`, {
      code: 'rate_limited',
      retryable: true,
      statusCode,
    });
  }
  if (isTimeout) {
    return new EmbeddingError(
      `Embedding request failed (status=${statusCode ?? 'unknown'}, code=timeout)`,
      { code: 'timeout', retryable: true, statusCode },
    );
  }
  if (statusCode === 409 || (statusCode !== null && statusCode >= 500)) {
    return new EmbeddingError(
      `Embedding request failed (status=${statusCode}, code=provider_unavailable)`,
      { code: 'provider_unavailable', retryable: true, statusCode },
    );
  }
  return new EmbeddingError(
    `Embedding request failed (status=${statusCode ?? 'unknown'}, code=request_failed)`,
    { code: 'request_failed', retryable: false, statusCode },
  );
}

function retryAfterSeconds(error: unknown): number | null {
  const headers = (error as { headers?: unknown } | null)?.headers;
  if (headers === null || headers === undefined) return null;
  const raw =
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : (headers as Record<string, unknown>)['retry-after'];
  if (raw === null || raw === undefined) return null;
  const value = Number(String(raw));
  return Number.isFinite(value) ? Math.max(value, 0) : null;
}

function validatedVectors(
  response: EmbeddingResponse,
  expectedCount: number,
  dimensions: number,
): number[][] {
  const data = [...response.data];
  if (data.length !== expectedCount) {
    throw new EmbeddingError(
      `Provider returned ${data.length} vectors for ${expectedCount} inputs`,
      { code: 'invalid_response', retryable: false },
    );
  }
  const ordered: (number[] | null)[] = Array.from({ length: expectedCount }, () => null);
  for (const item of data) {
    const index = Number(item.index);
    if (index < 0 || index >= expectedCount || ordered[index] !== null) {
      throw new EmbeddingError('Provider returned invalid or duplicate indexes', {
        code: 'invalid_response',
        retryable: false,
      });
    }
    const vector = item.embedding.map(Number);
    if (vector.length !== dimensions) {
      throw new EmbeddingError(
        `Provider returned dimension ${vector.length}, expected ${dimensions}`,
        { code: 'invalid_response', retryable: false },
      );
    }
    if (!vector.every((value) => Number.isFinite(value))) {
      throw new EmbeddingError('Provider returned non-finite embedding values', {
        code: 'invalid_response',
        retryable: false,
      });
    }
    ordered[index] = vector;
  }
  if (ordered.some((vector) => vector === null)) {
    throw new EmbeddingError('Provider response is missing embedding indexes', {
      code: 'invalid_response',
      retryable: false,
    });
  }
  return ordered as number[][];
}

/** 惰性加载 openai 包（skb 的 _default_client 语义：max_retries=0，重试自管）。 */
async function createDefaultClient(options: {
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<EmbeddingsClientLike> {
  const { default: OpenAI } = await import('openai');
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl.replace(/\/+$/, ''),
    timeout: options.timeoutSeconds * 1000,
    maxRetries: 0,
  }) as unknown as EmbeddingsClientLike;
}

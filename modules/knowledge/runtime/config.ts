import type { ModuleLogger, ModuleConfigScope } from '@reisa/module-sdk';
import { createHash } from 'node:crypto';

/**
 * 模块配置（skb config.py → 模块私有 settings.json，迁移设计文档 §7.2 / 决策 D4）。
 * embedding 配置（含 API Key）按用户决策保留在子模块内，经主设置页"模块设置"区维护。
 */

export const MIB = 1024 * 1024;

export interface EmbeddingSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize: number;
  readonly maxConcurrency: number;
  readonly timeoutSeconds: number;
  readonly maxRetries: number;
  readonly rateLimitRetryDelaySeconds: number;
}

export interface KnowledgeSettings {
  readonly uploadMaxBytes: number;
  readonly autoIndexMaxBytes: number;
  readonly syncIntervalSeconds: number;
  readonly syncDebounceSeconds: number;
  readonly embedding: EmbeddingSettings;
}

export const DEFAULT_SETTINGS: KnowledgeSettings = {
  uploadMaxBytes: 25 * MIB,
  autoIndexMaxBytes: 5 * MIB,
  syncIntervalSeconds: 600,
  syncDebounceSeconds: 2.0,
  embedding: {
    baseUrl: '',
    apiKey: '',
    model: '',
    dimensions: 1024,
    batchSize: 20,
    maxConcurrency: 2,
    timeoutSeconds: 30.0,
    maxRetries: 4,
    rateLimitRetryDelaySeconds: 30.0,
  },
};

export const CONFIG_KEY = 'config';

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value) === value ? value : value, min), max);
}

function normalizeEmbedding(raw: unknown): EmbeddingSettings {
  const source = (raw ?? {}) as Partial<EmbeddingSettings>;
  const defaults = DEFAULT_SETTINGS.embedding;
  return {
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : defaults.baseUrl,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : defaults.apiKey,
    model: typeof source.model === 'string' ? source.model : defaults.model,
    dimensions: clamp(
      source.dimensions ?? defaults.dimensions,
      1,
      Number.MAX_SAFE_INTEGER,
      defaults.dimensions,
    ),
    batchSize: clamp(source.batchSize ?? defaults.batchSize, 1, 20, defaults.batchSize),
    maxConcurrency: clamp(
      source.maxConcurrency ?? defaults.maxConcurrency,
      1,
      16,
      defaults.maxConcurrency,
    ),
    timeoutSeconds: Math.max(
      source.timeoutSeconds && Number.isFinite(source.timeoutSeconds)
        ? source.timeoutSeconds
        : defaults.timeoutSeconds,
      0.001,
    ),
    maxRetries: clamp(source.maxRetries ?? defaults.maxRetries, 0, 10, defaults.maxRetries),
    rateLimitRetryDelaySeconds: Math.max(
      source.rateLimitRetryDelaySeconds ?? defaults.rateLimitRetryDelaySeconds,
      0,
    ),
  };
}

function normalize(raw: unknown): KnowledgeSettings {
  const source = (raw ?? {}) as Partial<KnowledgeSettings>;
  return {
    uploadMaxBytes: Math.max(source.uploadMaxBytes ?? DEFAULT_SETTINGS.uploadMaxBytes, 1),
    // 0 = 关闭自动索引大小门槛（skb 语义）
    autoIndexMaxBytes: Math.max(source.autoIndexMaxBytes ?? DEFAULT_SETTINGS.autoIndexMaxBytes, 0),
    syncIntervalSeconds: Math.max(
      source.syncIntervalSeconds ?? DEFAULT_SETTINGS.syncIntervalSeconds,
      30,
    ),
    syncDebounceSeconds: Math.max(
      source.syncDebounceSeconds ?? DEFAULT_SETTINGS.syncDebounceSeconds,
      0,
    ),
    embedding: normalizeEmbedding(source.embedding),
  };
}

export async function loadSettings(config: ModuleConfigScope): Promise<KnowledgeSettings> {
  return normalize(await config.get(CONFIG_KEY));
}

export async function saveSettings(
  config: ModuleConfigScope,
  settings: KnowledgeSettings,
): Promise<void> {
  await config.set(CONFIG_KEY, settings as unknown as import('@reisa/module-sdk').JsonValue);
}

/**
 * embedding 配置指纹（skb Settings.embedding_identity）：
 * sha256(base_url \0 model \0 dimensions)。指纹变更触发清空索引全量重建。
 */
export function embeddingIdentity(settings: EmbeddingSettings): string {
  const payload = [
    settings.baseUrl.trim(),
    settings.model.trim(),
    String(settings.dimensions),
  ].join('\0');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export interface EmbedderStatus {
  readonly enabled: boolean;
  readonly reason?: string;
}

/** 端点 / 模型 / API Key 任一为空 → 不建索引，全文检索仍可用（skb _build_embedder 语义）。 */
export function embedderStatus(settings: EmbeddingSettings, logger?: ModuleLogger): EmbedderStatus {
  void logger;
  if (!settings.baseUrl.trim() || !settings.model.trim() || !settings.apiKey.trim()) {
    return { enabled: false, reason: 'Embedding service is not configured' };
  }
  return { enabled: true };
}

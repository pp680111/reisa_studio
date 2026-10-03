/**
 * 测试替身（移植自 skb tests/conftest.py 的 FakeEmbedder）：
 * sha256 → 归一化向量，全程离线、确定性。同文本同向量，不同文本不同向量。
 */
import { createHash } from 'node:crypto';

export function fakeVector(text, dimensions = 16) {
  const hash = createHash('sha256').update(text, 'utf8').digest();
  const raw = Array.from(
    { length: dimensions },
    (_, i) => (hash[i % hash.length] ?? 0) / 255 - 0.5,
  );
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1;
  return raw.map((value) => value / norm);
}

export function createFakeEmbedder(dimensions = 16) {
  const calls = [];
  return {
    calls,
    dimensions,
    embedCount: () => calls.length,
    async embed(texts) {
      calls.push([...texts]);
      return {
        vectors: texts.map((text) => fakeVector(text, dimensions)),
        promptTokens: null,
      };
    },
  };
}

/** 可编程失败/延迟的 embedder，用于降级与失败路径测试。 */
export function createStubEmbedder(overrides = {}) {
  return {
    embed: overrides.embed ?? (async () => ({ vectors: [], promptTokens: null })),
  };
}

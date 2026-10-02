import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';

export interface ProviderConnectionConfig {
  /** 服务商标识（日志与遥测用），不含凭据。 */
  readonly name?: string;
  readonly baseURL: string;
  /** 凭据经基础服务句柄传入，不写入工具定义或提示词（架构设计 §8.2）。 */
  readonly apiKey?: string;
  readonly modelId: string;
}

/** OpenAI 兼容端点的默认模型构造；真实服务商冒烟（选型文档 §4.1 第 6 项）使用此入口。 */
export function createOpenAICompatibleModel(config: ProviderConnectionConfig): LanguageModel {
  const provider = createOpenAICompatible({
    name: config.name ?? 'reisa-provider',
    baseURL: config.baseURL,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
  return provider.chatModel(config.modelId);
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly reply?: string;
  readonly error?: string;
}

/** 连接测试：一次最小补全。仅用于设置页的连接验证，不构成会话执行限制。 */
export async function testModelConnection(model: LanguageModel): Promise<ConnectionTestResult> {
  try {
    const result = await generateText({
      model,
      prompt: '连接测试。请只回复：OK',
    });
    return { ok: true, reply: result.text.trim() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

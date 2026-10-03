import { useEffect, useState } from 'react';
import { Badge, Button, Field, Icon } from '@reisa/ui';
import type { ModuleSettingsProps } from '@reisa/module-sdk';
import { callPage, pageBridgeAvailable } from './client.ts';
import './KnowledgeSettings.css';

/**
 * 知识库模块配置（module-ui-design §7；迁移设计文档决策 D4）：
 * embedding 服务端点 / 模型 / API Key / 向量维度等配置数据保存在子模块自己的
 * settings.json，经主设置页"模块设置"区或模块设置弹窗读写（同一组件、同一存储）。
 * 保存后模块按新配置就地重装配；embedding 指纹变更会自动清空索引全量重建。
 */

interface EmbeddingSettingsJson {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize: number;
  maxConcurrency: number;
  timeoutSeconds: number;
  maxRetries: number;
  rateLimitRetryDelaySeconds: number;
}

interface SettingsJson {
  uploadMaxBytes: number;
  autoIndexMaxBytes: number;
  syncIntervalSeconds: number;
  syncDebounceSeconds: number;
  embedding: EmbeddingSettingsJson;
}

const MIB = 1024 * 1024;

function displayMegabytes(bytes: number): number {
  return Number((bytes / MIB).toFixed(6));
}

export function KnowledgeSettings({ notify, close }: ModuleSettingsProps) {
  const [settings, setSettings] = useState<SettingsJson | null>(null);
  const [saving, setSaving] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySet, setApiKeySet] = useState(false);
  const available = pageBridgeAvailable();

  useEffect(() => {
    if (!available) return;
    void callPage<SettingsJson>('get_config')
      .then((loaded) => {
        setSettings(loaded);
        setApiKeySet((loaded.embedding?.apiKey ?? '').length > 0);
      })
      .catch((error) => notify(error instanceof Error ? error.message : String(error)));
  }, [available, notify]);

  if (!available) {
    return (
      <p className="knowledge-settings-state">模块配置需要桌面运行时；浏览器预览下不可编辑。</p>
    );
  }
  if (settings === null) {
    return (
      <p className="knowledge-settings-state" role="status">
        配置加载中…
      </p>
    );
  }

  const update = (patch: Partial<SettingsJson>): void => {
    setSettings({ ...settings, ...patch });
  };
  const updateEmbedding = (patch: Partial<EmbeddingSettingsJson>): void => {
    setSettings({ ...settings, embedding: { ...settings.embedding, ...patch } });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const embedding: EmbeddingSettingsJson = {
        ...settings.embedding,
        apiKey: apiKeyDraft.trim() ? apiKeyDraft.trim() : settings.embedding.apiKey,
      };
      const next = await callPage<SettingsJson>('update_config', {
        settings: { ...settings, embedding },
      });
      setSettings(next);
      setApiKeySet((next.embedding?.apiKey ?? '').length > 0);
      setApiKeyDraft('');
      notify('知识库配置已保存；若更换了 embedding 模型，索引会自动重建。');
      close?.();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const configured =
    settings.embedding.baseUrl.trim() !== '' &&
    settings.embedding.model.trim() !== '' &&
    settings.embedding.apiKey !== '';

  return (
    <form
      className="knowledge-settings"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void save();
      }}
    >
      <div className="knowledge-settings-body">
        <section className="knowledge-settings-section" aria-label="Embedding 服务">
          <header className="knowledge-settings-section-header">
            <h3>
              <Icon name="layers" size={16} />
              Embedding 服务
            </h3>
            <Badge tone={configured ? 'success' : ''}>{configured ? '已配置' : '仅全文检索'}</Badge>
          </header>
          <p className="knowledge-settings-description">
            连接 OpenAI 兼容的 Embedding 服务以启用向量检索。未配置时仍可使用全文检索。
          </p>
          <div className="knowledge-settings-grid">
            <Field label="服务地址（Base URL）">
              <input
                value={settings.embedding.baseUrl}
                onChange={(event) => updateEmbedding({ baseUrl: event.target.value })}
                placeholder="http://127.0.0.1:11434/v1"
              />
            </Field>
            <Field label="模型名">
              <input
                value={settings.embedding.model}
                onChange={(event) => updateEmbedding({ model: event.target.value })}
                placeholder="例如 qwen3-embedding:0.6b"
              />
            </Field>
            <Field
              label="API Key"
              hint={apiKeySet ? '已保存密钥；留空表示不修改' : '密钥保存在模块私有配置中'}
            >
              <input
                type="password"
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                placeholder={apiKeySet ? '••••••••' : 'sk-…'}
                autoComplete="off"
              />
            </Field>
            <Field label="向量维度" hint="需与所选模型的输出维度一致">
              <input
                type="number"
                min={1}
                value={settings.embedding.dimensions}
                onChange={(event) => updateEmbedding({ dimensions: Number(event.target.value) })}
              />
            </Field>
          </div>
        </section>

        <section className="knowledge-settings-section" aria-label="索引与扫描">
          <header className="knowledge-settings-section-header">
            <h3>
              <Icon name="history" size={16} />
              索引与扫描
            </h3>
          </header>
          <p className="knowledge-settings-description">
            控制文档大小限制，以及本地来源的自动同步频率。
          </p>
          <div className="knowledge-settings-grid">
            <Field label="自动索引门槛" hint="超过门槛需手动提交；0 表示不限大小">
              <div className="knowledge-settings-number">
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={displayMegabytes(settings.autoIndexMaxBytes)}
                  onChange={(event) =>
                    update({ autoIndexMaxBytes: Math.round(Number(event.target.value) * MIB) })
                  }
                />
                <span>MB</span>
              </div>
            </Field>
            <Field label="上传大小上限" hint="单个上传文档允许的最大大小">
              <div className="knowledge-settings-number">
                <input
                  type="number"
                  min={0.1}
                  step="0.1"
                  value={displayMegabytes(settings.uploadMaxBytes)}
                  onChange={(event) =>
                    update({ uploadMaxBytes: Math.round(Number(event.target.value) * MIB) })
                  }
                />
                <span>MB</span>
              </div>
            </Field>
            <Field label="全量扫描间隔" hint="定期检查来源文件，最短 30 秒">
              <div className="knowledge-settings-number">
                <input
                  type="number"
                  min={30}
                  value={settings.syncIntervalSeconds}
                  onChange={(event) => update({ syncIntervalSeconds: Number(event.target.value) })}
                />
                <span>秒</span>
              </div>
            </Field>
            <Field label="文件变更防抖" hint="等待变更稳定后同步，减少重复扫描">
              <div className="knowledge-settings-number">
                <input
                  type="number"
                  min={0}
                  step="0.5"
                  value={settings.syncDebounceSeconds}
                  onChange={(event) => update({ syncDebounceSeconds: Number(event.target.value) })}
                />
                <span>秒</span>
              </div>
            </Field>
          </div>
        </section>
      </div>
      <footer className="knowledge-settings-footer">
        <p>
          <Icon name="help" size={15} />
          更换服务、模型或向量维度后，索引会自动重建。
        </p>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? '保存中…' : '保存知识库配置'}
        </Button>
      </footer>
    </form>
  );
}

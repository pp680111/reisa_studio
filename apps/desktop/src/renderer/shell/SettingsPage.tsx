import { useEffect, useState } from 'react';
import type { ModuleContribution } from '@reisa/module-sdk';
import { Badge, Button, Field, Icon, PageHeading } from '@reisa/ui';
import type { ReisaBridge, ReisaConnectionTest, ReisaModelConnection } from '../bridge';
import type { Theme } from './preferences';
export function SettingsPage({
  theme,
  setTheme,
  modules,
  enabled,
  openModuleSettings,
  openCapabilities,
  notify,
  bridge,
  modelLabel,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  modules: readonly ModuleContribution[];
  enabled: readonly string[];
  openModuleSettings: (id: string) => void;
  openCapabilities: () => void;
  notify: (message: string) => void;
  /** 桌面运行时桥；浏览器预览下为 undefined，走本地演示模式。 */
  bridge?: ReisaBridge;
  /** 主会话模型显示名（由宿主从基础配置读取）。 */
  modelLabel?: string;
}) {
  const [section, setSection] = useState('基础配置');
  const [prompt, setPrompt] = useState('');
  const [dirty, setDirty] = useState(false);
  const [connection, setConnection] = useState<ReisaModelConnection | null>(null);
  const [baseURL, setBaseURL] = useState('');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ReisaConnectionTest | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void (async () => {
      const loaded = await bridge.settings.getModelConnection();
      setConnection(loaded);
      if (loaded) {
        setBaseURL(loaded.baseURL);
        setModelId(loaded.modelId);
      }
      setPrompt(await bridge.settings.getPrompt());
    })();
  }, [bridge]);

  const saveConnection = async () => {
    if (!bridge) return;
    if (!baseURL.trim() || !modelId.trim()) {
      notify('请填写服务地址与模型 ID。');
      return;
    }
    setSaving(true);
    try {
      await bridge.settings.setModelConnection({
        baseURL: baseURL.trim(),
        modelId: modelId.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      const loaded = await bridge.settings.getModelConnection();
      setConnection(loaded);
      setApiKey('');
      notify('模型连接已保存。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const runConnectionTest = async () => {
    if (!bridge) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await bridge.settings.testConnection();
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const savePrompt = async () => {
    setDirty(false);
    if (!bridge) {
      notify('提示词已保留在当前预览，尚未连接 Agent 或持久化。');
      return;
    }
    try {
      await bridge.settings.setPrompt(prompt);
      notify('默认提示词已保存。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="workspace-page settings-page">
      <PageHeading
        eyebrow="MAKE IT YOURS"
        title="按你的习惯，安放工作空间"
        description="共享基础配置，保留每个模块自己的选择。"
      />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分组">
          {[
            { name: '基础配置', icon: 'settings' },
            { name: '会话', icon: 'chat' },
            { name: '模块设置', icon: 'layers' },
          ].map((item) => (
            <button
              key={item.name}
              className={section === item.name ? 'active' : ''}
              onClick={() => setSection(item.name)}
            >
              <Icon name={item.icon} />
              {item.name}
              <Icon name="chevronRight" size={14} />
            </button>
          ))}
        </nav>
        <section className="settings-content" hidden={section !== '基础配置'}>
          <h2>基础配置</h2>
          <p className="muted">为所有工作空间提供一致的基础体验。</p>
          <div className="setting-block">
            <h3>外观</h3>
            <div className="theme-options">
              {(
                [
                  { value: 'light', label: '浅色', icon: 'sun' },
                  { value: 'dark', label: '深色', icon: 'moon' },
                  { value: 'system', label: '跟随系统', icon: 'monitor' },
                ] as const
              ).map((item) => (
                <button
                  key={item.value}
                  aria-pressed={theme === item.value}
                  className={theme === item.value ? 'active' : ''}
                  onClick={() => setTheme(item.value)}
                >
                  <div className={`theme-preview ${item.value}`}>
                    <span />
                    <div>
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                  <span>
                    <Icon name={item.icon} size={16} />
                    {item.label}
                    {theme === item.value && <Icon name="check" size={14} />}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="setting-block">
            <Field label="界面语言">
              <select disabled>
                <option>简体中文</option>
              </select>
            </Field>
          </div>
          <div className="setting-block">
            <div className="setting-row">
              <div>
                <h3>公共服务连接</h3>
                <p>提供共享的模型服务连接（OpenAI 兼容端点）。</p>
              </div>
              {bridge ? (
                <Badge>{connection ? '已配置' : '尚未配置'}</Badge>
              ) : (
                <Badge>尚未配置</Badge>
              )}
            </div>
            {bridge ? (
              <>
                <Field label="服务地址（Base URL）">
                  <input
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                </Field>
                <Field label="模型 ID">
                  <input
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder="例如 gpt-4o-mini、glm-4 …"
                  />
                </Field>
                <Field
                  label="API Key"
                  hint={
                    connection?.hasApiKey
                      ? '已保存密钥；留空表示不修改'
                      : '密钥只保存在本机凭据存储'
                  }
                >
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={connection?.hasApiKey ? '••••••••' : 'sk-…'}
                    autoComplete="off"
                  />
                </Field>
                <div className="form-footer">
                  {testResult && (
                    <small className={testResult.ok ? 'test-ok' : 'test-failed'}>
                      {testResult.ok
                        ? `连接正常：${testResult.reply ?? 'OK'}`
                        : `连接失败：${testResult.error}`}
                    </small>
                  )}
                  <div>
                    <Button
                      variant="ghost"
                      disabled={testing || saving}
                      onClick={() => void runConnectionTest()}
                    >
                      <Icon name="sparkles" size={14} />
                      {testing ? '测试中…' : '测试连接'}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={saving || testing}
                      onClick={() => void saveConnection()}
                    >
                      {saving ? '保存中…' : '保存连接'}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <Button onClick={() => notify('服务连接编辑与凭据管理将在基础服务接入后提供。')}>
                <Icon name="plus" />
                添加连接
              </Button>
            )}
          </div>
          <div className="setting-block">
            <Field label="网络代理" hint="代理配置将在平台服务接入后开放">
              <input placeholder="使用系统代理" disabled />
            </Field>
          </div>
        </section>
        <section className="settings-content" hidden={section !== '会话'}>
          <h2>会话设置</h2>
          <p className="muted">只影响主会话，不改变模块的独立模型。</p>
          <div className="setting-block">
            <Field label="默认主会话模型">
              <select disabled>
                <option>{modelLabel ?? '连接服务后选择模型'}</option>
              </select>
            </Field>
          </div>
          <div className="setting-block">
            <Field label="默认提示词">
              <textarea
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setDirty(true);
                }}
                rows={6}
                placeholder="描述你希望 Agent 如何与你协作…"
              />
            </Field>
            <div className="form-footer">
              <small>{dirty ? '未保存' : bridge ? '已保存' : '本地预览'}</small>
              <Button variant="primary" onClick={() => void savePrompt()}>
                {bridge ? '保存提示词' : '应用到预览'}
              </Button>
            </div>
          </div>
          <div className="setting-block">
            <h3>公开能力</h3>
            <p className="muted">启用模块的全部公开能力，不在会话内筛选工具。</p>
            <Button onClick={openCapabilities}>
              查看能力声明
              <Icon name="arrowRight" size={14} />
            </Button>
          </div>
        </section>
        <section className="settings-content" hidden={section !== '模块设置'}>
          <h2>模块设置</h2>
          <p className="muted">设置由所属模块定义和管理。</p>
          {modules
            .filter((module) => enabled.includes(module.id) && module.settings)
            .map((module) => (
              <div className="module-setting-row" key={module.id}>
                <span className="module-symbol">
                  <Icon name={module.navigation?.icon ?? 'layers'} />
                </span>
                <div>
                  <strong>{module.name}</strong>
                  <p>{module.description}</p>
                </div>
                <Button onClick={() => openModuleSettings(module.id)}>
                  设置
                  <Icon name="arrowRight" size={14} />
                </Button>
              </div>
            ))}
        </section>
      </div>
    </div>
  );
}

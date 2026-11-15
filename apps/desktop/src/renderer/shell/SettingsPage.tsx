import { useEffect, useState } from 'react';
import type { ModuleContribution } from '@reisa/module-sdk';
import { Badge, Button, Dialog, Field, Icon, PageHeading } from '@reisa/ui';
import type {
  ReisaBridge,
  ReisaConnectionTest,
  ReisaDataDirectory,
  ReisaMigrationStats,
  ReisaModelConnection,
} from '../bridge';
import { RolesManager } from './RolesManager';
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
  onConnectionSaved,
  onRolesChanged,
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
  /** 模型连接保存成功后的回调；宿主借此刷新右上角模型显示名。 */
  onConnectionSaved?: () => void;
  /** 角色变更后的回调；宿主借此刷新角色选择器与会话徽标数据。 */
  onRolesChanged?: () => void;
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
  const [dataDir, setDataDir] = useState<ReisaDataDirectory | null>(null);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrationStats, setMigrationStats] = useState<ReisaMigrationStats | null>(null);

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
      // 数据目录读取失败不阻断页面：状态保持未知，迁移入口按无效处理
      await bridge.settings
        .getDataDirectory()
        .then(setDataDir)
        .catch(() => setDataDir(null));
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
      onConnectionSaved?.();
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

  /** 选择迁移目标目录；仅记录，待用户在确认对话框中发起迁移。 */
  const pickDataDirectory = async () => {
    if (!bridge) return;
    const picked = await bridge.settings.pickDataDirectory();
    if (picked !== null) setPendingTarget(picked);
  };

  /**
   * 执行数据迁移：主进程会先停用模块并关闭会话库，复制完成后写指针。
   * 成功后应用处于"待重启"状态（其余桥接调用均不可用），由完成对话框引导重启。
   */
  const runMigration = async () => {
    if (!bridge || pendingTarget === null) return;
    setMigrating(true);
    try {
      const stats = await bridge.settings.migrateDataDirectory(pendingTarget);
      setPendingTarget(null);
      setMigrationStats(stats);
    } catch (error) {
      setPendingTarget(null);
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setMigrating(false);
    }
  };

  const restartForMigration = () => {
    if (!bridge) return;
    void bridge.app.restart();
  };

  return (
    <div className="workspace-page settings-page">
      <PageHeading eyebrow="MAKE IT YOURS" title="按你的习惯，安放工作空间" />
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
          <div className="setting-block">
            <div className="setting-row">
              <div>
                <h3>数据目录</h3>
                <p>会话记录、模块数据与基础配置的存放位置。</p>
              </div>
              {dataDir ? (
                <Badge>{dataDir.isCustom ? '自定义位置' : '默认位置'}</Badge>
              ) : (
                <Badge>未知</Badge>
              )}
            </div>
            {bridge && dataDir ? (
              <>
                <Field
                  label="当前数据目录"
                  hint="更改时将完整复制数据到新目录，原目录保留为备份；完成后引导重启。"
                >
                  <div className="settings-path-row">
                    <input value={dataDir.root} readOnly />
                    <Button disabled={migrating} onClick={() => void pickDataDirectory()}>
                      <Icon name="folder" size={14} />
                      更改目录
                    </Button>
                  </div>
                </Field>
                {dataDir.isCustom && (
                  <div className="form-footer">
                    <small>当前使用自定义数据目录，可迁移回默认位置。</small>
                    <Button
                      variant="ghost"
                      disabled={migrating}
                      onClick={() => setPendingTarget(dataDir.defaultRoot)}
                    >
                      恢复默认位置
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <Field label="当前数据目录" hint="桌面运行时接入后可在此调整数据存放位置。">
                <input placeholder="跟随系统默认位置" disabled />
              </Field>
            )}
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
            <Field label="默认提示词" hint="会话未选择角色时生效；选择角色的会话使用角色提示词">
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
            <RolesManager bridge={bridge} notify={notify} onChanged={onRolesChanged} />
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
          <p className="muted">
            每个模块在此维护自己的独有配置（迁移设计文档 §8.2）；配置数据保存在模块私有存储中。
          </p>
          {modules.filter((module) => enabled.includes(module.id) && module.settings).length ===
          0 ? (
            <p className="muted">当前没有提供配置的已启用模块。</p>
          ) : null}
          {modules
            .filter((module) => enabled.includes(module.id) && module.settings)
            .map((module) => {
              const Settings = module.settings;
              return (
                <div className="setting-block" key={module.id}>
                  <div className="setting-row">
                    <span className="module-symbol">
                      <Icon name={module.navigation?.icon ?? 'layers'} />
                    </span>
                    <div>
                      <strong>{module.name}</strong>
                      <p>{module.description}</p>
                    </div>
                  </div>
                  {Settings && <Settings notify={notify} />}
                </div>
              );
            })}
        </section>
      </div>
      <Dialog
        open={pendingTarget !== null}
        onClose={() => {
          if (!migrating) setPendingTarget(null);
        }}
        title="迁移数据目录"
      >
        <div className="settings-form">
          <p>
            将把数据从 <span className="settings-migrate-path">{dataDir?.root}</span> 完整复制到：
          </p>
          <p className="settings-migrate-path">{pendingTarget}</p>
          <p className="muted">
            复制期间将停用模块并关闭会话库，进行中的会话会被中断；原目录保留为备份，不会被删除。
            复制完成后需要重启应用以切换到新目录。
          </p>
          <div className="form-footer">
            <small>目标须为空目录；迁移失败时自动回滚，当前数据不受影响。</small>
            <div>
              <Button variant="ghost" disabled={migrating} onClick={() => setPendingTarget(null)}>
                取消
              </Button>
              <Button variant="primary" disabled={migrating} onClick={() => void runMigration()}>
                {migrating ? '迁移中…' : '开始迁移'}
              </Button>
            </div>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={migrationStats !== null}
        onClose={() => {
          setMigrationStats(null);
          notify('数据目录已迁移，请尽快重启应用以完成切换。');
        }}
        title="迁移完成"
      >
        <div className="settings-form">
          <p>已复制 {migrationStats?.files ?? 0} 个文件到新数据目录。</p>
          <p className="muted">原目录已保留为备份；重启后应用将从新目录读取数据。</p>
          <div className="form-footer">
            <small>重启后生效。</small>
            <div>
              <Button variant="primary" onClick={restartForMigration}>
                立即重启
              </Button>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

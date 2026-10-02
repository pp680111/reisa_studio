import { useState } from 'react';
import type { ModuleContribution } from '@reisa/module-sdk';
import { Badge, Button, Field, Icon, PageHeading } from '@reisa/ui';
import type { Theme } from './preferences';
export function SettingsPage({
  theme,
  setTheme,
  modules,
  enabled,
  openModuleSettings,
  openCapabilities,
  notify,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  modules: readonly ModuleContribution[];
  enabled: readonly string[];
  openModuleSettings: (id: string) => void;
  openCapabilities: () => void;
  notify: (message: string) => void;
}) {
  const [section, setSection] = useState('基础配置');
  const [prompt, setPrompt] = useState('');
  const [dirty, setDirty] = useState(false);
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
                <p>提供共享的模型服务连接。</p>
              </div>
              <Badge>尚未配置</Badge>
            </div>
            <Button onClick={() => notify('服务连接编辑与凭据管理将在基础服务接入后提供。')}>
              <Icon name="plus" />
              添加连接
            </Button>
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
                <option>连接服务后选择模型</option>
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
              <small>{dirty ? '未保存' : '本地预览'}</small>
              <Button
                variant="primary"
                onClick={() => {
                  setDirty(false);
                  notify('提示词已保留在当前预览，尚未连接 Agent 或持久化。');
                }}
              >
                应用到预览
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

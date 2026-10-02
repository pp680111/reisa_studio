import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, Icon, IconButton } from '@reisa/ui';
import { modules } from '../../composition/modules';
import {
  ConversationView,
  createConversation,
  type Conversation,
} from '../conversation/ConversationView';
import { AppSidebar } from './AppSidebar';
import { ModuleManager } from './ModuleManager';
import { SettingsPage } from './SettingsPage';
import { QuickSwitcher } from './QuickSwitcher';
import { ResultContainer } from './ResultContainer';
import { navigationModules } from './navigation.mjs';
import { isBoolean, isStrings, isTheme, usePreference } from './preferences';

const initialConversation = createConversation();
const sampleConversation: Conversation = {
  id: 'sample-brand',
  title: '品牌灵感与创作',
  draft: '',
  messages: [],
  attachments: [],
  sample: true,
};
export function AppShell() {
  const [route, setRoute] = useState('conversation');
  const [conversations, setConversations] = useState<Conversation[]>([
    initialConversation,
    sampleConversation,
  ]);
  const [activeConversationId, setActiveConversationId] = useState(initialConversation.id);
  const [collapsedPreference, setCollapsedPreference] = usePreference(
    'collapsed',
    false,
    isBoolean,
  );
  const [narrow, setNarrow] = useState(window.innerWidth <= 680);
  const collapsed = narrow || collapsedPreference;
  const [theme, setTheme] = usePreference('theme', 'system', isTheme);
  const [enabled, setEnabled] = usePreference(
    'enabled',
    modules.map((module) => module.id),
    isStrings,
  );
  const [pinned, setPinned] = usePreference<string[]>('pinned', [], isStrings);
  const [recent, setRecent] = usePreference<string[]>('recentModules', [], isStrings);
  const [quickOpen, setQuickOpen] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [capabilityModuleId, setCapabilityModuleId] = useState<string | null>(null);
  const [settingsModuleId, setSettingsModuleId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const availableModules = navigationModules(modules, enabled, pinned);
  const capabilityCount = modules
    .filter((module) => enabled.includes(module.id))
    .reduce((sum, module) => sum + module.capabilities.length, 0);
  const conversation = conversations.find((item) => item.id === activeConversationId)!;
  const currentModule = modules.find((module) => module.id === route);
  const navigate = (nextRoute: string, conversationId?: string) => {
    if (
      nextRoute !== 'conversation' &&
      nextRoute !== 'modules' &&
      nextRoute !== 'settings' &&
      !availableModules.some((module) => module.id === nextRoute)
    ) {
      setNotice('模块不可用，请先在模块管理中启用。');
      return;
    }
    setRoute(nextRoute);
    if (conversationId) setActiveConversationId(conversationId);
    if (availableModules.some((module) => module.id === nextRoute))
      setRecent((previous) => [nextRoute, ...previous.filter((id) => id !== nextRoute)]);
  };
  const newConversation = () => {
    const next = createConversation();
    setConversations((previous) => [next, ...previous]);
    setActiveConversationId(next.id);
    setRoute('conversation');
  };
  useEffect(() => {
    const media = window.matchMedia('(max-width: 680px)');
    const change = () => setNarrow(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen((previous) => !previous);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newConversation();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  const showCapabilities = (id: string | null = null) => {
    setCapabilityModuleId(id);
    setCapabilityOpen(true);
  };
  const toggleModule = (id: string) => {
    const disabling = enabled.includes(id);
    setEnabled((previous) =>
      disabling ? previous.filter((item) => item !== id) : [...previous, id],
    );
    if (disabling && route === id) {
      setRoute('modules');
      setNotice('当前模块已停用，工作空间入口已撤销。');
    }
    if (disabling && settingsModuleId === id) setSettingsModuleId(null);
  };
  const togglePin = (id: string) =>
    setPinned((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
  const movePinned = (id: string, direction: number) =>
    setPinned((previous) => {
      const next = [...previous];
      const position = next.indexOf(id);
      const target = position + direction;
      if (position >= 0 && target >= 0 && target < next.length)
        [next[position], next[target]] = [next[target]!, next[position]!];
      return next;
    });
  return (
    <div className="app-shell">
      <AppSidebar
        collapsed={collapsed}
        route={route}
        modules={availableModules}
        conversations={conversations}
        activeConversationId={activeConversationId}
        navigate={navigate}
        newConversation={newConversation}
        openQuickSwitch={() => setQuickOpen(true)}
        pinned={pinned}
        togglePin={togglePin}
        movePinned={movePinned}
      />
      <div className="app-workspace">
        <header className="workspace-header">
          <div className="header-location">
            <IconButton
              name={collapsed ? 'expand' : 'collapse'}
              label={narrow ? '窄窗口已自动收起侧栏' : collapsed ? '展开侧栏' : '收起侧栏'}
              disabled={narrow}
              onClick={() => setCollapsedPreference(!collapsedPreference)}
            />
            <span className="header-divider" />
            <Icon
              name={
                currentModule?.navigation?.icon ??
                (route === 'modules' ? 'layers' : route === 'settings' ? 'settings' : 'chat')
              }
              size={17}
            />
            <strong>
              {currentModule?.name ??
                (route === 'modules'
                  ? '模块管理'
                  : route === 'settings'
                    ? '设置'
                    : conversation.title)}
            </strong>
          </div>
          <div className="header-actions">
            {route === 'conversation' && (
              <>
                <select className="model-selector" aria-label="主会话模型" disabled>
                  <option>模型未配置</option>
                </select>
                <Button variant="ghost" onClick={() => showCapabilities()}>
                  <Icon name="layers" size={16} />
                  <span>能力 {capabilityCount}</span>
                </Button>
              </>
            )}
            <Badge>UI 预览</Badge>
          </div>
        </header>
        <main className="workspace-body">
          <div className="page-outlet conversation-outlet" hidden={route !== 'conversation'}>
            {conversations.map((item) => (
              <div
                className="conversation-instance"
                key={item.id}
                hidden={activeConversationId !== item.id}
              >
                <ConversationView
                  conversation={item}
                  update={(next) =>
                    setConversations((previous) =>
                      previous.map((value) => (value.id === next.id ? next : value)),
                    )
                  }
                  capabilityCount={capabilityCount}
                  openCapabilities={() => showCapabilities()}
                  enabledIds={enabled}
                  notify={setNotice}
                  renderResult={(result) => (
                    <ResultContainer result={result} modules={modules} enabled={enabled} />
                  )}
                />
              </div>
            ))}
          </div>
          <div className="page-outlet" hidden={route !== 'modules'}>
            <ModuleManager
              modules={modules}
              enabled={enabled}
              toggle={toggleModule}
              open={navigate}
              viewCapabilities={showCapabilities}
            />
          </div>
          <div className="page-outlet" hidden={route !== 'settings'}>
            <SettingsPage
              theme={theme}
              setTheme={setTheme}
              modules={modules}
              enabled={enabled}
              openModuleSettings={setSettingsModuleId}
              openCapabilities={() => showCapabilities()}
              notify={setNotice}
            />
          </div>
          {modules.map((module) => {
            const Page = module.navigation?.page;
            return (
              Page && (
                <div
                  className="page-outlet"
                  key={module.id}
                  hidden={route !== module.id || !enabled.includes(module.id)}
                >
                  <Page
                    openSettings={() => setSettingsModuleId(module.id)}
                    notify={setNotice}
                    availableModuleIds={enabled}
                  />
                </div>
              )
            );
          })}
        </main>
      </div>
      <QuickSwitcher
        open={quickOpen}
        close={() => setQuickOpen(false)}
        modules={modules}
        enabled={enabled}
        pinned={pinned}
        recent={recent}
        navigate={navigate}
      />
      <Dialog
        open={capabilityOpen}
        onClose={() => setCapabilityOpen(false)}
        title={
          capabilityModuleId
            ? `${modules.find((module) => module.id === capabilityModuleId)?.name ?? ''} · 公开能力`
            : '公开能力声明'
        }
        wide
      >
        <div className="capability-dialog">
          <p className="muted">只读接口声明 · 运行层尚未注册执行处理器</p>
          {modules
            .filter((module) =>
              capabilityModuleId ? module.id === capabilityModuleId : enabled.includes(module.id),
            )
            .map((module) => (
              <section key={module.id}>
                <h3>
                  <Icon name={module.navigation?.icon ?? 'layers'} />
                  {module.name}
                  <Badge>{module.capabilities.length} 项</Badge>
                  {!enabled.includes(module.id) && <Badge>已停用</Badge>}
                </h3>
                {module.capabilities.map((capability) => (
                  <div className="capability-row" key={capability.id}>
                    <code>{capability.name}</code>
                    <p>{capability.description}</p>
                  </div>
                ))}
              </section>
            ))}
          {capabilityCount === 0 && !capabilityModuleId && (
            <p>所有模块已停用，仍可使用普通文本会话界面。</p>
          )}
          <div className="info-box">
            仅查看接口描述。不会读取模块文档、文件或私有设置，也不提供逐工具开关。
          </div>
        </div>
      </Dialog>
      {modules.map((module) => {
        const Settings = module.settings;
        return (
          Settings && (
            <Dialog
              key={module.id}
              open={settingsModuleId === module.id && enabled.includes(module.id)}
              onClose={() => setSettingsModuleId(null)}
              title={`${module.name} · 模块设置`}
              feedback={notice}
            >
              <Settings notify={setNotice} />
            </Dialog>
          )
        );
      })}
      <div className={`toast ${notice ? 'visible' : ''}`} role="status" aria-live="polite">
        {notice && (
          <>
            <Icon name="help" />
            <span>{notice}</span>
            <IconButton name="close" label="关闭提示" onClick={() => setNotice('')} />
          </>
        )}
      </div>
    </div>
  );
}

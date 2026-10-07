import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Dialog, Icon, IconButton } from '@reisa/ui';
import { modules } from '../../composition/modules';
import {
  ConversationView,
  createConversation,
  type Conversation,
} from '../conversation/ConversationView';
import { getBridge, type ReisaCapability } from '../bridge';
import { AppSidebar } from './AppSidebar';
import { CapabilityDialog } from './CapabilityDialog';
import { ModuleManager } from './ModuleManager';
import { SettingsPage } from './SettingsPage';
import { QuickSwitcher } from './QuickSwitcher';
import { ResultContainer } from './ResultContainer';
import { navigationModules } from './navigation.mjs';
import { isBoolean, isStrings, isTheme, usePreference } from './preferences';
import {
  deriveEnabledModules,
  toRuntimeStates,
  toRuntimeStatus,
  type ModuleRuntimeStatus,
} from './moduleRuntime';

const initialConversation = createConversation();
/** 会话列表分页大小；上一批满页时侧栏显示「加载更多」。 */
const CONVERSATION_PAGE_SIZE = 20;
/** 内置模块 UI 清单的 id 列表（模块常量，启动后不变）。 */
const MODULE_IDS = modules.map((module) => module.id);
const sampleConversation: Conversation = {
  id: 'sample-brand',
  title: '品牌灵感与创作',
  draft: '',
  messages: [],
  attachments: [],
  sample: true,
};
export function AppShell() {
  const bridge = useMemo(() => getBridge(), []);
  const bootstrapRef = useRef(false);
  const [route, setRoute] = useState('conversation');
  const [conversations, setConversations] = useState<Conversation[]>(
    bridge ? [] : [initialConversation, sampleConversation],
  );
  const [activeConversationId, setActiveConversationId] = useState(
    bridge ? '' : initialConversation.id,
  );
  const [collapsedPreference, setCollapsedPreference] = usePreference(
    'collapsed',
    false,
    isBoolean,
  );
  const [narrow, setNarrow] = useState(window.innerWidth <= 680);
  const collapsed = narrow || collapsedPreference;
  const [theme, setTheme] = usePreference('theme', 'system', isTheme);
  // 模块启用集合以宿主为唯一来源（架构设计 §10）：bootstrap 从 reisa/modules/list
  // 对齐，之后由宿主状态事件实时维护；浏览器预览（无 bridge）下状态为空 → 全部可用。
  const [runtimeStates, setRuntimeStates] = useState<Record<string, ModuleRuntimeStatus>>({});
  // 桌面模式下等宿主状态就绪后再挂载模块页面，避免启动时对未启用模块发起页面调用
  const [moduleStatesLoaded, setModuleStatesLoaded] = useState(false);
  const enabled = useMemo(() => deriveEnabledModules(MODULE_IDS, runtimeStates), [runtimeStates]);
  const [pinned, setPinned] = usePreference<string[]>('pinned', [], isStrings);
  const [recent, setRecent] = usePreference<string[]>('recentModules', [], isStrings);
  const [quickOpen, setQuickOpen] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [capabilityModuleId, setCapabilityModuleId] = useState<string | null>(null);
  const [settingsModuleId, setSettingsModuleId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [liveCapabilities, setLiveCapabilities] = useState<ReisaCapability[] | null>(null);
  const [modelLabel, setModelLabel] = useState('模型未配置');
  const togglePending = useRef(new Set<string>());
  const availableModules = navigationModules(modules, enabled, pinned);
  const capabilityCount =
    liveCapabilities?.length ??
    modules
      .filter((module) => enabled.includes(module.id))
      .reduce((sum, module) => sum + module.capabilities.length, 0);
  const conversation = conversations.find((item) => item.id === activeConversationId);
  const currentModule = modules.find((module) => module.id === route);

  // 桌面运行时：加载会话列表（空则创建首个会话）与全量能力描述
  useEffect(() => {
    if (!bridge || bootstrapRef.current) return;
    bootstrapRef.current = true;
    void (async () => {
      const list = await bridge.conversation.listConversations({ limit: CONVERSATION_PAGE_SIZE });
      const first = list[0];
      if (first) {
        setConversations(
          list.map((item) => ({
            id: item.id,
            title: item.title,
            draft: '',
            messages: [],
            attachments: [],
          })),
        );
        setActiveConversationId(first.id);
      } else {
        const created = await bridge.conversation.createConversation();
        setConversations([
          { id: created.id, title: created.title, draft: '', messages: [], attachments: [] },
        ]);
        setActiveConversationId(created.id);
      }
      setLiveCapabilities(await bridge.conversation.listCapabilities());
      // 初始启用集合来自宿主状态（不再读 localStorage 副本）
      setRuntimeStates(toRuntimeStates(await bridge.conversation.listModules()));
      setModuleStatesLoaded(true);
      const connection = await bridge.settings.getModelConnection();
      setModelLabel(connection?.modelId ?? '模型未配置');
    })();
  }, [bridge]);
  // 订阅宿主生命周期状态：activating/deactivating 过渡与 failed 原因实时可见
  useEffect(() => {
    if (!bridge) return;
    return bridge.conversation.onModuleState((status) => {
      setRuntimeStates((previous) => ({
        ...previous,
        [status.id]: toRuntimeStatus(status),
      }));
    });
  }, [bridge]);
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
    if (bridge) {
      void bridge.conversation.createConversation().then((created) => {
        const next: Conversation = {
          id: created.id,
          title: created.title,
          draft: '',
          messages: [],
          attachments: [],
        };
        setConversations((previous) => [next, ...previous]);
        setActiveConversationId(next.id);
        setRoute('conversation');
      });
      return;
    }
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
    // 过渡/处理期间忽略重复操作（按钮同时禁用）
    if (togglePending.current.has(id)) return;
    // 停用成功后的界面收尾：撤销工作空间入口、关闭已打开的模块设置
    const settleAfterDisable = () => {
      if (disabling && route === id) {
        setRoute('modules');
        setNotice('当前模块已停用，工作空间入口已撤销。');
      }
      if (disabling && settingsModuleId === id) setSettingsModuleId(null);
    };
    if (!bridge) {
      setRuntimeStates((previous) => ({
        ...previous,
        [id]: toRuntimeStatus({ state: disabling ? 'disabled' : 'active' }),
      }));
      settleAfterDisable();
      return;
    }
    togglePending.current.add(id);
    void bridge.conversation
      .setModuleEnabled(id, !disabling)
      .then(async (result) => {
        if (result.error) {
          // 真实状态（failed + 原因）由宿主状态事件送达，这里只提示失败
          setNotice(`模块${disabling ? '停用' : '启用'}失败：${result.error}`);
          return;
        }
        // 非运行时模块没有状态事件，按返回结果对齐；运行时模块以事件为准
        setRuntimeStates((previous) => ({
          ...previous,
          [id]: toRuntimeStatus({
            state: result.state ?? (disabling ? 'disabled' : 'active'),
          }),
        }));
        settleAfterDisable();
        // 启停改变了能力集合：重新拉取，能力计数与集合保持实时
        setLiveCapabilities(await bridge.conversation.listCapabilities());
      })
      .finally(() => {
        togglePending.current.delete(id);
      });
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
  const deleteConversation = (id: string) => {
    if (bridge) void bridge.conversation.deleteConversation(id);
    const remaining = conversations.filter((item) => item.id !== id);
    setConversations(remaining);
    if (activeConversationId === id) setActiveConversationId(remaining[0]?.id ?? '');
  };
  const renameConversation = (id: string, title: string) => {
    if (bridge) void bridge.conversation.renameConversation(id, title);
    setConversations((previous) =>
      previous.map((item) => (item.id === id ? { ...item, title } : item)),
    );
  };
  const loadMoreConversations = () => {
    if (!bridge) return;
    void bridge.conversation
      .listConversations({ limit: CONVERSATION_PAGE_SIZE, offset: conversations.length })
      .then((list) => {
        if (list.length === 0) return;
        const known = new Set(conversations.map((item) => item.id));
        setConversations((previous) => [
          ...previous,
          ...list
            .filter((item) => !known.has(item.id))
            .map((item) => ({
              id: item.id,
              title: item.title,
              draft: '',
              messages: [],
              attachments: [],
            })),
        ]);
      });
  };
  const canLoadMore = bridge !== undefined && conversations.length >= CONVERSATION_PAGE_SIZE;
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
        renameConversation={renameConversation}
        deleteConversation={deleteConversation}
        loadMoreConversations={loadMoreConversations}
        canLoadMore={canLoadMore}
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
                    : (conversation?.title ?? '会话'))}
            </strong>
          </div>
          <div className="header-actions">
            {route === 'conversation' && (
              <>
                <select
                  className="model-selector"
                  aria-label="主会话模型"
                  title={bridge ? '在设置中配置模型连接' : '模型连接在设置中配置'}
                  onClick={() => {
                    if (!bridge) setNotice('模型连接将在基础服务接入后提供。');
                  }}
                  disabled={false}
                >
                  <option>{modelLabel}</option>
                </select>
                <Button variant="ghost" onClick={() => showCapabilities()}>
                  <Icon name="layers" size={16} />
                  <span>能力 {capabilityCount}</span>
                </Button>
              </>
            )}
            {!bridge && <Badge>UI 预览</Badge>}
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
                  notify={setNotice}
                  bridge={bridge}
                  toolAction={(toolName) =>
                    modules
                      .flatMap((module) => module.capabilities)
                      .find((capability) => capability.name === toolName)?.description ?? toolName
                  }
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
              runtimeStates={bridge ? runtimeStates : undefined}
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
              bridge={bridge}
              modelLabel={modelLabel}
            />
          </div>
          {modules.map((module) => {
            const Page = module.navigation?.page;
            // 停用即卸载：未启用模块不渲染页面，轮询等副作用随卸载停止，重新启用重新初始加载；
            // 启用模块用 hidden 保持挂载，切页不丢编辑状态。
            // 桌面模式等宿主状态就绪后再挂载，启动时未启用模块的页面不会挂载。
            const mounted =
              Page !== undefined && enabled.includes(module.id) && (!bridge || moduleStatesLoaded);
            return (
              mounted && (
                <div className="page-outlet" key={module.id} hidden={route !== module.id}>
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
      <CapabilityDialog
        open={capabilityOpen}
        onClose={() => setCapabilityOpen(false)}
        moduleId={capabilityModuleId}
        modules={modules}
        enabled={enabled}
        runtimeConnected={bridge !== undefined}
        liveCapabilities={liveCapabilities}
        capabilityCount={capabilityCount}
      />
      {modules.map((module) => {
        const Settings = module.settings;
        return (
          Settings && (
            <Dialog
              key={module.id}
              open={settingsModuleId === module.id && enabled.includes(module.id)}
              onClose={() => setSettingsModuleId(null)}
              title={`${module.name} · 模块设置`}
              wide={module.id === 'knowledge' || module.id === 'card-note'}
              feedback={notice}
            >
              <Settings notify={setNotice} close={() => setSettingsModuleId(null)} />
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

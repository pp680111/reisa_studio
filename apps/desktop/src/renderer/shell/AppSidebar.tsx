import { useLayoutEffect, useRef, useState } from 'react';
import type { ModuleContribution } from '@reisa/module-sdk';
import { Icon, IconButton } from '@reisa/ui';
import type { Conversation } from '../conversation/ConversationView';
import { isBoolean, usePreference } from './preferences';

const shortcutModifier = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';
export function AppSidebar({
  collapsed,
  route,
  modules,
  conversations,
  activeConversationId,
  navigate,
  newConversation,
  renameConversation,
  deleteConversation,
  loadMoreConversations,
  canLoadMore,
  openQuickSwitch,
  pinned,
  togglePin,
  movePinned,
}: {
  collapsed: boolean;
  route: string;
  modules: readonly ModuleContribution[];
  conversations: readonly Conversation[];
  activeConversationId: string;
  navigate: (route: string, conversationId?: string) => void;
  newConversation: () => void;
  renameConversation?: (id: string, title: string) => void;
  deleteConversation?: (id: string) => void;
  loadMoreConversations?: () => void;
  canLoadMore?: boolean;
  openQuickSwitch: () => void;
  pinned: readonly string[];
  togglePin: (id: string) => void;
  movePinned: (id: string, direction: number) => void;
}) {
  const [workspaceOpen, setWorkspaceOpen] = usePreference('workspaceOpen', true, isBoolean);
  const [recentOpen, setRecentOpen] = usePreference('recentOpen', true, isBoolean);
  const [recentQuery, setRecentQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const scrolling = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    try {
      if (scrolling.current)
        scrolling.current.scrollTop = Number(sessionStorage.getItem('reisa.ui.sidebarScroll') ?? 0);
    } catch {
      /* optional preference */
    }
  }, []);
  useLayoutEffect(() => {
    if (route !== 'conversation' && route !== 'modules' && route !== 'settings')
      scrolling.current
        ?.querySelector('[aria-current="page"]')
        ?.scrollIntoView({ block: 'nearest' });
  }, [route]);
  const item = (
    label: string,
    icon: string,
    id: string,
    action: () => void,
    extra?: React.ReactNode,
  ) => (
    <button
      className={`nav-item ${route === id ? 'active' : ''}`}
      aria-current={route === id ? 'page' : undefined}
      title={collapsed ? label : undefined}
      aria-label={label}
      onClick={action}
    >
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
      {extra}
    </button>
  );
  return (
    <aside className={`app-sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="应用导航">
      <div className="sidebar-top">
        <div className="brand">
          <div className="brand-symbol">
            R<span />
          </div>
          <div className="brand-copy">
            <strong>Reisa Studio</strong>
            <small>你的 AI 工作空间</small>
          </div>
        </div>
        <button className="new-conversation" title="新建会话" onClick={newConversation}>
          <Icon name="plus" size={19} />
          <span className="nav-label">新建会话</span>
          <kbd>{shortcutModifier} N</kbd>
        </button>
        <nav className="global-navigation">
          {item('会话', 'chat', 'conversation', () => navigate('conversation'))}
          {item('模块管理', 'layers', 'modules', () => navigate('modules'))}
          <button
            className="nav-item"
            onClick={openQuickSwitch}
            aria-label="打开模块"
            title="打开模块（Ctrl / ⌘ + K）"
          >
            <Icon name="search" />
            <span className="nav-label">打开模块</span>
            <kbd>{shortcutModifier} K</kbd>
          </button>
        </nav>
      </div>
      <div
        className="sidebar-scroll"
        ref={scrolling}
        onScroll={(e) => {
          try {
            sessionStorage.setItem('reisa.ui.sidebarScroll', String(e.currentTarget.scrollTop));
          } catch {
            /* optional preference */
          }
        }}
      >
        <div className="nav-group">
          <button
            className="group-label"
            onClick={() => setWorkspaceOpen(!workspaceOpen)}
            aria-expanded={workspaceOpen}
          >
            <span>工作空间</span>
            <Icon name={workspaceOpen ? 'chevronDown' : 'chevronRight'} size={13} />
          </button>
          {(workspaceOpen || collapsed) && (
            <nav>
              {modules.map((module) => (
                <div className="module-nav-row" key={module.id}>
                  {item(
                    module.name,
                    module.navigation!.icon,
                    module.id,
                    () => navigate(module.id),
                    pinned.includes(module.id) ? (
                      <Icon name="pin" size={12} className="pin-mark" />
                    ) : undefined,
                  )}
                  <div className="nav-row-actions">
                    <IconButton
                      name="pin"
                      label={`${pinned.includes(module.id) ? '取消置顶' : '置顶'}${module.name}`}
                      onClick={() => togglePin(module.id)}
                    />
                    {pinned.includes(module.id) && (
                      <>
                        <IconButton
                          name="arrowUp"
                          label={`上移${module.name}`}
                          onClick={() => movePinned(module.id, -1)}
                        />
                        <IconButton
                          name="arrowDown"
                          label={`下移${module.name}`}
                          onClick={() => movePinned(module.id, 1)}
                        />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </nav>
          )}
        </div>
        {!collapsed && (
          <div className="nav-group recent-group">
            <button
              className="group-label"
              onClick={() => setRecentOpen(!recentOpen)}
              aria-expanded={recentOpen}
            >
              <span>最近会话</span>
              <Icon name={recentOpen ? 'chevronDown' : 'chevronRight'} size={13} />
            </button>
            {recentOpen && conversations.length > 0 && (
              <div className="recent-search">
                <Icon name="search" size={13} />
                <input
                  value={recentQuery}
                  onChange={(e) => setRecentQuery(e.target.value)}
                  aria-label="搜索会话"
                  placeholder="搜索会话…"
                />
              </div>
            )}
            {recentOpen &&
              conversations
                .filter((conversation) =>
                  conversation.title.toLocaleLowerCase().includes(recentQuery.toLocaleLowerCase()),
                )
                .map((conversation) => (
                  <div className="module-nav-row" key={conversation.id}>
                    {editingId === conversation.id ? (
                      <input
                        className="recent-rename"
                        value={editingTitle}
                        autoFocus
                        aria-label="会话名称"
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={() => {
                          const title = editingTitle.trim();
                          if (title && renameConversation)
                            renameConversation(conversation.id, title);
                          setEditingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditingId(null);
                          if (
                            e.key === 'Enter' &&
                            !e.nativeEvent.isComposing &&
                            e.keyCode !== 229
                          ) {
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      <button
                        className={`recent-item ${route === 'conversation' && activeConversationId === conversation.id ? 'active' : ''}`}
                        aria-current={
                          route === 'conversation' && activeConversationId === conversation.id
                            ? 'page'
                            : undefined
                        }
                        onDoubleClick={() => {
                          if (!renameConversation) return;
                          setEditingId(conversation.id);
                          setEditingTitle(conversation.title);
                        }}
                        onClick={() => navigate('conversation', conversation.id)}
                        title={conversation.title}
                      >
                        <Icon name="chat" size={14} />
                        <span>{conversation.title}</span>
                      </button>
                    )}
                    {(renameConversation || deleteConversation) && (
                      <div className="nav-row-actions">
                        {renameConversation && editingId !== conversation.id && (
                          <IconButton
                            name="edit"
                            label={`重命名会话 ${conversation.title}`}
                            onClick={() => {
                              setEditingId(conversation.id);
                              setEditingTitle(conversation.title);
                            }}
                          />
                        )}
                        {deleteConversation && (
                          <IconButton
                            name="close"
                            label={`删除会话 ${conversation.title}`}
                            onClick={() => deleteConversation(conversation.id)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))}
            {recentOpen && recentQuery && conversations.length > 0 && (
              <p className="empty-search">没有匹配的会话</p>
            )}
            {recentOpen && canLoadMore && loadMoreConversations && (
              <button className="load-more" onClick={loadMoreConversations}>
                加载更多会话
                <Icon name="chevronDown" size={13} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="sidebar-bottom">
        {item('设置', 'settings', 'settings', () => navigate('settings'))}
      </div>
    </aside>
  );
}

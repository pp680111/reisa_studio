import { useEffect, useRef, useState } from 'react';
import type { ModuleContribution } from '@reisa/module-sdk';
import { Dialog, Icon } from '@reisa/ui';
import { navigationModules } from './navigation.mjs';
export function QuickSwitcher({
  open,
  close,
  modules,
  enabled,
  pinned,
  recent,
  navigate,
}: {
  open: boolean;
  close: () => void;
  modules: readonly ModuleContribution[];
  enabled: readonly string[];
  pinned: readonly string[];
  recent: readonly string[];
  navigate: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const matches = navigationModules(modules, enabled, pinned, recent, query);
  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);
  const selectedIndex = Math.min(index, Math.max(0, matches.length - 1));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open)
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedIndex, query]);
  return (
    <Dialog open={open} onClose={close} title="打开模块">
      <div className="quick-switcher">
        <div className="search-field">
          <Icon name="search" />
          <input
            autoFocus
            aria-label="搜索工作空间模块"
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-module-list"
            aria-autocomplete="list"
            aria-activedescendant={
              matches.length ? `quick-${matches[selectedIndex]!.id}` : undefined
            }
            placeholder="搜索模块名称、别名或用途…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((selectedIndex + 1) % Math.max(1, matches.length));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((selectedIndex + matches.length - 1) % Math.max(1, matches.length));
              }
              if (e.key === 'Enter' && matches[selectedIndex]) {
                e.preventDefault();
                navigate(matches[selectedIndex]!.id);
                close();
              }
            }}
          />
        </div>
        <div className="list-label">{query ? '匹配的工作空间' : '置顶与最近打开'}</div>
        <div
          ref={list}
          id="quick-module-list"
          className="quick-list"
          role="listbox"
          aria-label="模块搜索结果"
        >
          {matches.map((module, i) => (
            <button
              key={module.id}
              id={`quick-${module.id}`}
              role="option"
              aria-selected={i === selectedIndex}
              className={i === selectedIndex ? 'active' : ''}
              onMouseMove={() => setIndex(i)}
              onClick={() => {
                navigate(module.id);
                close();
              }}
            >
              <Icon name={module.navigation!.icon} />
              <div>
                <strong>{module.name}</strong>
                <small>{module.description}</small>
              </div>
              {pinned.includes(module.id) && <Icon name="pin" size={14} />}
              <Icon name="arrowRight" size={16} />
            </button>
          ))}
        </div>
        {matches.length === 0 && (
          <div className="empty-search">
            没有匹配的模块
            <button className="text-button" onClick={() => setQuery('')}>
              清空查询
            </button>
            <button
              className="text-button"
              onClick={() => {
                navigate('modules');
                close();
              }}
            >
              进入模块管理
            </button>
          </div>
        )}
        <div className="quick-footer">
          <span>↑ ↓ 选择 · Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </Dialog>
  );
}

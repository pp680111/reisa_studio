import { useState } from 'react';
import type { ModuleContribution } from '@reisa/module-sdk';
import { Badge, Button, Icon, PageHeading } from '@reisa/ui';
import { isTransitioning } from './moduleRuntime';
export function ModuleManager({
  modules,
  enabled,
  toggle,
  open,
  viewCapabilities,
  runtimeStates,
}: {
  modules: readonly ModuleContribution[];
  enabled: readonly string[];
  toggle: (id: string) => void;
  open: (id: string) => void;
  viewCapabilities: (id: string) => void;
  /** 桌面运行时下各模块的生命周期状态；浏览器预览为 undefined。 */
  runtimeStates?: Readonly<Record<string, { state: string; error?: string }>>;
}) {
  const [query, setQuery] = useState('');
  return (
    <div className="workspace-page manager-page">
      <PageHeading eyebrow="YOUR TOOLKIT" title="为工作空间，添一点可能">
        <Badge>{enabled.length} 个模块已启用</Badge>
      </PageHeading>
      <div className="manager-toolbar">
        <div className="search-field">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索模块"
            placeholder="搜索模块名称或用途…"
          />
        </div>
        <span className="muted">内置模块</span>
      </div>
      <div className="module-cards">
        {modules
          .filter((module) =>
            `${module.name} ${module.description}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          )
          .map((module) => {
            const status = runtimeStates?.[module.id];
            const busy = isTransitioning(status?.state);
            return (
              <article className="module-card" key={module.id}>
                <div className="module-card-top">
                  <span className="module-symbol">
                    <Icon name={module.navigation?.icon ?? 'layers'} size={25} />
                  </span>
                  <button
                    className="switch"
                    role="switch"
                    aria-label={`${enabled.includes(module.id) ? '停用' : '启用'}${module.name}`}
                    aria-checked={enabled.includes(module.id)}
                    disabled={busy}
                    title={busy ? '模块正在切换运行状态' : undefined}
                    onClick={() => toggle(module.id)}
                  >
                    <span />
                  </button>
                </div>
                <h2>
                  {module.name}
                  <Badge>{module.source === 'builtin' ? '内置' : '外部'}</Badge>
                  {runtimeStates && (
                    <Badge>
                      {status?.state === 'active'
                        ? '运行中'
                        : status?.state === 'failed'
                          ? '运行异常'
                          : status?.state === 'activating'
                            ? '激活中'
                            : status?.state === 'deactivating'
                              ? '停用中'
                              : status
                                ? '已接入运行时'
                                : '界面原型'}
                    </Badge>
                  )}
                </h2>
                <p>{module.description}</p>
                {status?.state === 'failed' && status.error !== undefined && (
                  <p className="muted" role="alert">
                    {`运行异常：${status.error}`}
                  </p>
                )}
                <div className="module-card-meta">
                  <span>v{module.version}</span>
                  <span>{module.capabilities.length} 项能力声明</span>
                  <span className={enabled.includes(module.id) ? 'enabled-label' : ''}>
                    {enabled.includes(module.id) ? '已启用' : '已停用'}
                  </span>
                </div>
                <div className="module-card-actions">
                  <Button variant="ghost" onClick={() => viewCapabilities(module.id)}>
                    查看能力
                    <Icon name="arrowRight" size={14} />
                  </Button>
                  {module.navigation && (
                    <Button disabled={!enabled.includes(module.id)} onClick={() => open(module.id)}>
                      打开工作空间
                      <Icon name="arrowRight" size={14} />
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
      </div>
      {modules.length > 0 &&
        !modules.some((module) =>
          `${module.name} ${module.description}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        ) && <p className="empty-search">没有匹配的模块</p>}
      {modules.length === 0 && (
        <p className="empty-search">
          当前没有接入任何模块。模块接入后，这里可以查看、启停并打开其工作空间。
        </p>
      )}
      <div className="info-box">
        <Icon name="help" />
        {runtimeStates
          ? '启停驱动运行层生命周期与公开能力集合；未标注「运行中」的模块暂无运行时，启停只保存配置。停用不会删除模块数据。'
          : '启停目前只控制界面入口与公开声明展示，运行层生命周期尚未接入。停用不会删除模块数据。'}
      </div>
    </div>
  );
}

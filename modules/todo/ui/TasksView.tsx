import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, EmptyState, Icon, IconButton } from '@reisa/ui';
import { TODO_STATES } from '../domain/todo-state.ts';
import {
  deleteTodo,
  errorMessage,
  listCategories,
  listTodos,
  updateTodoStatus,
  type CategoryJson,
  type TodoJson,
} from './client.ts';
import { formatDateTime } from './format.ts';

export function TasksView({
  notify,
  refreshToken,
  onEdit,
  onCreate,
}: {
  notify: (message: string) => void;
  refreshToken: number;
  onEdit: (todoId: number) => void;
  onCreate: () => void;
}) {
  const [todos, setTodos] = useState<TodoJson[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchKey, setSearchKey] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [status, setStatus] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [categories, setCategories] = useState<CategoryJson[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const pageRef = useRef(1);
  const loadingRef = useRef(false);
  const requestRef = useRef(0);
  const retryPageRef = useRef(1);
  const filtersSet = status !== null || categoryId !== null || searchKey.trim() !== '';

  const loadPage = useCallback(
    async (page: number) => {
      // 新筛选始终发起请求，旧查询的响应不得覆盖当前视图。
      if (page > 1 && loadingRef.current) return;
      const request = ++requestRef.current;
      retryPageRef.current = page;
      loadingRef.current = true;
      setLoadingMore(page > 1);
      setLoadError(null);
      try {
        const result = await listTodos({
          page,
          pageSize: 20,
          searchKey: searchKey.trim() || null,
          status,
          categoryId,
        });
        if (request !== requestRef.current) return;
        pageRef.current = page;
        setHasMore(result.hasMore);
        setTodos((previous) =>
          page === 1 || previous === null ? result.items : dedupeAppend(previous, result.items),
        );
      } catch (error) {
        if (request === requestRef.current) setLoadError(errorMessage(error));
      } finally {
        if (request === requestRef.current) {
          loadingRef.current = false;
          setLoadingMore(false);
        }
      }
    },
    [categoryId, searchKey, status],
  );

  useEffect(() => {
    pageRef.current = 1;
    setTodos(null);
    setHasMore(false);
    void loadPage(1);
    return () => {
      requestRef.current += 1;
      loadingRef.current = false;
    };
  }, [loadPage, refreshToken]);

  useEffect(() => {
    let cancelled = false;
    listCategories({ page: 1, pageSize: 50 })
      .then((result) => {
        if (!cancelled) setCategories(result.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null || !hasMore || loadError !== null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !loadingRef.current) {
          void loadPage(pageRef.current + 1);
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadPage, loadError, todos]);

  const clearPending = (id: number) =>
    setPendingIds((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });

  // 写操作结束时刷新当前查询；操作期间用户可能已经切换筛选。
  const reloadRef = useRef(loadPage);
  reloadRef.current = loadPage;

  const handleToggleStatus = async (todo: TodoJson) => {
    const nextStatus = todo.status === 2 ? 0 : 2;
    setPendingIds((previous) => new Set(previous).add(todo.id));
    try {
      await updateTodoStatus(todo.id, nextStatus);
      await reloadRef.current(1);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      clearPending(todo.id);
    }
  };

  const handleDelete = async (todo: TodoJson) => {
    if (!window.confirm(`删除待办「${todo.title}」？\n其进度记录将一并删除，且不可恢复。`)) return;
    setPendingIds((previous) => new Set(previous).add(todo.id));
    try {
      await deleteTodo(todo.id);
      await reloadRef.current(1);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      clearPending(todo.id);
    }
  };

  const handleReset = () => {
    setSearchKey('');
    setStatus(null);
    setCategoryId(null);
  };

  return (
    <div className="todo-view">
      <div className="todo-toolbar">
        <div className="todo-search" role="search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索待办"
            value={searchKey}
            placeholder="搜索待办标题…"
            onChange={(event) => setSearchKey(event.target.value)}
          />
          {searchKey !== '' && (
            <IconButton name="close" label="清空搜索" onClick={() => setSearchKey('')} />
          )}
        </div>
        <Button
          variant="ghost"
          className={`todo-filter-toggle${filterOpen || categoryId !== null ? ' active' : ''}`}
          aria-expanded={filterOpen}
          aria-controls="todo-category-filter"
          onClick={() => setFilterOpen((open) => !open)}
        >
          <Icon name="sliders" size={16} />
          分类筛选
          {categoryId !== null && <span className="todo-filter-count">1</span>}
        </Button>
      </div>
      <div className="todo-status-filters" role="group" aria-label="按状态筛选待办">
        <button type="button" aria-pressed={status === null} onClick={() => setStatus(null)}>
          全部
        </button>
        {TODO_STATES.map((state) => (
          <button
            type="button"
            key={state.key}
            aria-pressed={status === state.key}
            onClick={() => setStatus(state.key)}
          >
            <span className={`todo-state-dot todo-state-${state.key}`} aria-hidden="true" />
            {state.text}
          </button>
        ))}
      </div>
      {filterOpen && (
        <div className="todo-filter-bar" id="todo-category-filter">
          <label className="todo-filter-item">
            <span>分类</span>
            <span className="todo-select-wrap">
              <select
                value={categoryId ?? ''}
                onChange={(event) =>
                  setCategoryId(event.target.value === '' ? null : Number(event.target.value))
                }
              >
                <option value="">全部分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" size={14} className="todo-select-caret" />
            </span>
          </label>
          {categoryId !== null && (
            <Button variant="ghost" onClick={() => setCategoryId(null)}>
              清除分类
            </Button>
          )}
        </div>
      )}
      <div className="todo-list-panel" aria-busy={todos === null && loadError === null}>
        <div className="todo-list-heading">
          <span>
            {todos === null
              ? '待办列表'
              : hasMore
                ? `已加载 ${todos.length} 项`
                : `${todos.length} 项待办`}
          </span>
          <div className="todo-list-heading-actions">
            {categoryId !== null && (
              <button
                type="button"
                className="todo-filter-chip"
                onClick={() => setCategoryId(null)}
                aria-label="清除分类筛选"
              >
                {categories.find((category) => category.id === categoryId)?.name ?? '所选分类'}
                <Icon name="close" size={12} />
              </button>
            )}
            {filtersSet && (
              <Button variant="ghost" onClick={handleReset}>
                清除筛选
              </Button>
            )}
          </div>
        </div>
        {todos === null && loadError === null && (
          <p className="todo-loading" role="status">
            正在加载待办…
          </p>
        )}
        {todos !== null && todos.length === 0 && (
          <EmptyState
            icon={filtersSet ? 'search' : 'check'}
            title={filtersSet ? '没有匹配的待办' : '还没有待办'}
            description={
              filtersSet
                ? '试试其他关键词，或清除筛选条件。'
                : '把要做的事记下来，从第一项待办开始。'
            }
          >
            <Button
              variant={filtersSet ? 'secondary' : 'primary'}
              onClick={filtersSet ? handleReset : onCreate}
            >
              {filtersSet ? '清除筛选' : '新建待办'}
            </Button>
          </EmptyState>
        )}
        {todos !== null && todos.length > 0 && (
          <ul className="todo-list" aria-label="待办列表">
            {todos.map((todo) => (
              <li key={todo.id} className={`todo-row${todo.status === 2 ? ' completed' : ''}`}>
                <button
                  type="button"
                  className={`todo-status-toggle todo-status-${todo.status}`}
                  aria-label={`${todo.status === 2 ? '标记未完成' : '标记完成'}「${todo.title}」（当前：${todo.statusText}）`}
                  aria-pressed={todo.status === 2}
                  title={todo.status === 2 ? '标记未完成' : '标记完成'}
                  disabled={pendingIds.has(todo.id)}
                  onClick={() => void handleToggleStatus(todo)}
                >
                  {todo.status === 2 && <Icon name="check" size={14} />}
                  {todo.status === 1 && <span className="todo-status-inner" />}
                  {todo.status === 3 && <span aria-hidden="true">!</span>}
                </button>
                <button
                  type="button"
                  className="todo-row-main"
                  onClick={() => onEdit(todo.id)}
                  aria-label={`查看待办「${todo.title}」`}
                >
                  <span className="todo-row-info">
                    <span className="todo-row-title-line">
                      <span className="todo-row-title">{todo.title}</span>
                      <span className={`todo-state-label todo-state-${todo.status}`}>
                        {todo.statusText}
                      </span>
                    </span>
                    {(todo.categoryName !== null || todo.deadlineTime !== null) && (
                      <span className="todo-row-meta">
                        {todo.categoryName !== null && (
                          <span>
                            <Icon name="folder" size={12} />
                            {todo.categoryName}
                          </span>
                        )}
                        {todo.deadlineTime !== null && (
                          <span>
                            <Icon name="history" size={12} />
                            截止 {formatDateTime(todo.deadlineTime)}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
                <div className="todo-row-actions">
                  <IconButton
                    name="trash"
                    label={`删除「${todo.title}」`}
                    disabled={pendingIds.has(todo.id)}
                    onClick={() => void handleDelete(todo)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        {loadError !== null && (
          <div className="todo-load-error" role="alert">
            <span>{loadError}</span>
            <Button variant="secondary" onClick={() => void loadPage(retryPageRef.current)}>
              重试
            </Button>
          </div>
        )}
        <div ref={sentinelRef} className="todo-sentinel" aria-hidden="true" />
        {hasMore && loadError === null && (
          <div className="todo-list-footer">
            <Button
              variant="ghost"
              disabled={loadingMore}
              onClick={() => void loadPage(pageRef.current + 1)}
            >
              {loadingMore ? '正在加载更多…' : '加载更多'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function dedupeAppend(previous: TodoJson[], incoming: readonly TodoJson[]): TodoJson[] {
  const seen = new Set(previous.map((item) => item.id));
  return [...previous, ...incoming.filter((item) => !seen.has(item.id))];
}

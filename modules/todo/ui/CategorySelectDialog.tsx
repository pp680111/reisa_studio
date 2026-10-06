import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, EmptyState, Icon } from '@reisa/ui';
import { errorMessage, listCategories, type CategoryJson } from './client.ts';

/**
 * 分类选择弹窗（源 CategorySelectDialog）：搜索 + 分页列表（每页 50），
 * 点击回传所选分类，可选择“未分类”清除关联，并标记当前选项。
 */
export function CategorySelectDialog({
  open,
  onPick,
  onClose,
  selectedId,
}: {
  open: boolean;
  onPick: (category: CategoryJson | null) => void;
  onClose: () => void;
  selectedId: number | null;
}) {
  const [searchKey, setSearchKey] = useState('');
  const [categories, setCategories] = useState<CategoryJson[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(
    async (targetPage: number, replace: boolean) => {
      const request = ++requestRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const result = await listCategories({
          page: targetPage,
          pageSize: 50,
          searchKey: searchKey.trim() === '' ? null : searchKey.trim(),
        });
        if (request !== requestRef.current) return;
        setPage(targetPage);
        setHasMore(result.hasMore);
        setCategories((previous) => (replace ? result.items : [...previous, ...result.items]));
      } catch (error) {
        if (request === requestRef.current) setLoadError(errorMessage(error));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [searchKey],
  );

  useEffect(() => {
    if (open) {
      setCategories([]);
      setHasMore(false);
      void load(1, true);
    }
    return () => {
      requestRef.current += 1;
    };
  }, [open, load]);

  return (
    <Dialog open={open} onClose={onClose} title="选择分类">
      <div className="todo-dialog-body">
        <div className="todo-search todo-select-search" role="search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索分类"
            value={searchKey}
            placeholder="搜索分类…"
            autoFocus
            onChange={(event) => setSearchKey(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="todo-select-row"
          aria-pressed={selectedId === null}
          onClick={() => {
            onPick(null);
            onClose();
          }}
        >
          <Icon name="folder" size={16} />
          未分类
          {selectedId === null && <Icon name="check" size={16} className="todo-select-check" />}
        </button>
        {loading && (
          <p className="todo-loading" role="status">
            正在加载分类…
          </p>
        )}
        {loadError !== null && (
          <div className="todo-load-error" role="alert">
            <span>{loadError}</span>
            <Button
              onClick={() =>
                void load(categories.length === 0 ? 1 : page + 1, categories.length === 0)
              }
            >
              重试
            </Button>
          </div>
        )}
        {categories.length === 0 && !loading && loadError === null && (
          <EmptyState
            icon="folder"
            title={searchKey.trim() === '' ? '还没有分类' : '没有匹配的分类'}
            description={
              searchKey.trim() === ''
                ? '可先选择“未分类”，或在分类页创建分类。'
                : '试试其他关键词。'
            }
          />
        )}
        {categories.length > 0 && (
          <ul className="todo-select-list">
            {categories.map((category) => (
              <li key={category.id}>
                <button
                  type="button"
                  className="todo-select-row"
                  aria-pressed={selectedId === category.id}
                  onClick={() => {
                    onPick(category);
                    onClose();
                  }}
                >
                  <Icon name="folder" size={16} />
                  {category.name}
                  {selectedId === category.id && (
                    <Icon name="check" size={16} className="todo-select-check" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="todo-dialog-actions">
          {hasMore && (
            <Button variant="ghost" disabled={loading} onClick={() => void load(page + 1, false)}>
              {loading ? '加载中…' : '加载更多'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, EmptyState, Icon, IconButton } from '@reisa/ui';
import {
  deleteCategory,
  errorMessage,
  listCategories,
  saveCategory,
  type CategoryJson,
} from './client.ts';
import { formatDateTime } from './format.ts';
import { PromptDialog } from './PromptDialog.tsx';

/**
 * 分类管理（源 CategoryList / CategoryDetail / CategoryListItem）：
 * 名称搜索 + createTime 升序列表 + 增删改；删除分类后待办分类关联自动置空（R6②）。
 */
export function CategoriesView({
  notify,
  refreshToken,
  creating,
  onCreate,
  onCreateClose,
}: {
  notify: (message: string) => void;
  refreshToken: number;
  creating: boolean;
  onCreate: () => void;
  onCreateClose: () => void;
}) {
  const [categories, setCategories] = useState<CategoryJson[] | null>(null);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<CategoryJson | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoadError(null);
    try {
      const result = await listCategories({
        searchKey: query.trim() === '' ? null : query.trim(),
        pageSize: 50,
      });
      if (request === requestRef.current) setCategories(result.items);
    } catch (error) {
      if (request === requestRef.current) setLoadError(errorMessage(error));
    }
  }, [query]);

  useEffect(() => {
    setCategories(null);
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh, refreshToken]);

  const handleCreate = async (name: string) => {
    try {
      await saveCategory({ categoryId: null, name });
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
      throw error;
    }
  };

  const handleRename = async (categoryId: number, name: string) => {
    try {
      await saveCategory({ categoryId, name });
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
      throw error;
    }
  };

  const handleDelete = async (category: CategoryJson) => {
    if (!window.confirm(`删除分类「${category.name}」？\n关联待办会保留，但分类将置为“未分类”。`)) {
      return;
    }
    try {
      await deleteCategory(category.id);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  return (
    <div className="todo-view">
      <div className="todo-toolbar">
        <div className="todo-search" role="search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索分类"
            value={query}
            placeholder="搜索分类…"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== '' && (
            <IconButton name="close" label="清空分类搜索" onClick={() => setQuery('')} />
          )}
        </div>
      </div>
      <div className="todo-list-panel">
        <div className="todo-list-heading">
          <span>{categories === null ? '分类列表' : `${categories.length} 个分类`}</span>
        </div>
        {categories === null && loadError === null && (
          <p className="todo-loading" role="status">
            正在加载分类…
          </p>
        )}
        {categories !== null && categories.length === 0 && (
          <EmptyState
            icon="folder"
            title={query.trim() !== '' ? '没有匹配的分类' : '还没有分类'}
            description={
              query.trim() !== ''
                ? '试试其他关键词，或清空搜索。'
                : '创建分类，让工作、生活和学习各有归属。'
            }
          >
            <Button
              variant={query.trim() !== '' ? 'secondary' : 'primary'}
              onClick={query.trim() !== '' ? () => setQuery('') : onCreate}
            >
              {query.trim() !== '' ? '清空搜索' : '新建分类'}
            </Button>
          </EmptyState>
        )}
        {categories !== null && categories.length > 0 && (
          <ul className="todo-list" aria-label="分类列表">
            {categories.map((category) => (
              <li key={category.id} className="todo-row">
                <span className="todo-category-symbol">
                  <Icon name="folder" size={18} />
                </span>
                <button
                  type="button"
                  className="todo-row-main"
                  onClick={() => setRenaming(category)}
                  aria-label={`重命名「${category.name}」`}
                >
                  <span className="todo-row-info">
                    <span className="todo-row-title">{category.name}</span>
                    <span className="todo-row-meta">
                      <span>创建于 {formatDateTime(category.createTime)}</span>
                    </span>
                  </span>
                </button>
                <div className="todo-row-actions">
                  <IconButton
                    name="edit"
                    label={`重命名「${category.name}」`}
                    onClick={() => setRenaming(category)}
                  />
                  <IconButton
                    name="trash"
                    label={`删除「${category.name}」`}
                    onClick={() => void handleDelete(category)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        {loadError !== null && (
          <div className="todo-load-error" role="alert">
            <span>{loadError}</span>
            <Button onClick={() => void refresh()}>重试</Button>
          </div>
        )}
      </div>

      <PromptDialog
        open={creating}
        title="新建分类"
        label="名称"
        placeholder="例如：工作"
        confirmText="创建"
        onSubmit={handleCreate}
        onClose={onCreateClose}
      />
      <PromptDialog
        open={renaming !== null}
        title="重命名分类"
        label="名称"
        initial={renaming?.name ?? ''}
        confirmText="保存"
        onSubmit={(name) => handleRename(renaming?.id ?? 0, name)}
        onClose={() => setRenaming(null)}
      />
    </div>
  );
}

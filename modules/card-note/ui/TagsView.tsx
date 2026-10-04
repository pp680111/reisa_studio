import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Icon, IconButton, PageHeading } from '@reisa/ui';
import { deleteTag, ensureTag, errorMessage, listTags, renameTag, type TagJson } from './client.ts';
import { PromptDialog } from './PromptDialog.tsx';

/**
 * 全局标签管理（源 TagManagementPage，FR-03）：
 * 标签库跨书籍共享；重命名做归一化唯一性校验；删除仅解除关联、不删笔记。
 */
export function TagsView({
  notify,
  onBack,
}: {
  notify: (message: string) => void;
  onBack: () => void;
}) {
  const [tags, setTags] = useState<TagJson[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<TagJson | null>(null);

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      try {
        setTags(await listTags());
      } catch (error) {
        if (options?.silent !== true) notify(errorMessage(error));
      }
    },
    [notify],
  );

  // Q5 刷新策略：操作后主动刷新 + 5 秒轮询；轮询承接页面外变更（克隆/同步导入、
  // 后台自动同步），失败时静默保留当前数据，避免错误提示重复弹出。
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh({ silent: true }), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleCreate = async (name: string) => {
    try {
      await ensureTag(name);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const handleRename = async (tagId: string, name: string) => {
    try {
      await renameTag(tagId, name);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const handleDelete = async (tag: TagJson) => {
    if (!window.confirm(`删除标签「${tag.name}」？\n将从所有笔记移除该标签，笔记本身不受影响。`)) {
      return;
    }
    try {
      await deleteTag(tag.id);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  return (
    <div className="card-note-view">
      <div className="card-note-toolbar">
        <Button variant="ghost" onClick={onBack}>
          ← 返回书籍
        </Button>
      </div>

      <PageHeading eyebrow="整理与分类" title="标签管理">
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} /> 新建标签
        </Button>
      </PageHeading>
      <p className="card-note-result-count" role="status">
        {tags === null ? '正在加载标签…' : `共 ${tags.length} 个标签`}
      </p>

      {tags !== null && tags.length === 0 && (
        <EmptyState
          icon="star"
          title="还没有标签"
          description="创建标签，或在笔记编辑器中随用随建。"
        >
          <Button variant="primary" onClick={() => setCreating(true)}>
            新建标签
          </Button>
        </EmptyState>
      )}

      {tags !== null && tags.length > 0 && (
        <ul className="card-note-tag-list">
          {tags.map((tag) => (
            <li key={tag.id}>
              <span className="card-note-tag-title">{tag.name}</span>
              <div className="card-note-row-actions">
                <IconButton
                  name="edit"
                  label={`重命名「${tag.name}」`}
                  onClick={() => setRenaming(tag)}
                />
                <IconButton
                  name="trash"
                  label={`删除「${tag.name}」`}
                  onClick={() => void handleDelete(tag)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <PromptDialog
        open={creating}
        title="新建标签"
        label="标签名"
        placeholder="例如：架构"
        confirmText="创建"
        onSubmit={handleCreate}
        onClose={() => setCreating(false)}
      />
      <PromptDialog
        open={renaming !== null}
        title="重命名标签"
        label="标签名"
        initial={renaming?.name ?? ''}
        hint="若与已有标签重名（不区分大小写），操作会被拒绝。"
        confirmText="保存"
        onSubmit={(name) => handleRename(renaming?.id ?? '', name)}
        onClose={() => setRenaming(null)}
      />
    </div>
  );
}

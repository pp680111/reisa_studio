import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, IconButton } from '@reisa/ui';
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

  const refresh = useCallback(async () => {
    try {
      setTags(await listTags());
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [notify]);

  useEffect(() => {
    void refresh();
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
        <Button variant="primary" onClick={() => setCreating(true)}>
          新建标签
        </Button>
      </div>

      <div className="card-note-section-heading">
        <h1>标签管理</h1>
        <p>标签库在全部书籍之间共享；大小写与首尾空格差异不会创建重复标签。</p>
      </div>

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

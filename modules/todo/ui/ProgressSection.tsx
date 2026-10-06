import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, IconButton } from '@reisa/ui';
import {
  addProgress,
  deleteProgress,
  errorMessage,
  listProgress,
  updateProgressFinished,
  type ProgressJson,
} from './client.ts';
import { formatDateTime } from './format.ts';

/**
 * 进度区块（源 TodoThingProgressList / ProgressListItem / TodoThingProgressFormDialog）：
 * 未完成在前（isFinished ASC, id ASC）；勾选切换完成标记；点内容查看全文；删除即刷新。
 */
export function ProgressSection({
  todoId,
  notify,
}: {
  todoId: number;
  notify: (message: string) => void;
}) {
  const [items, setItems] = useState<ProgressJson[] | null>(null);
  const [draft, setDraft] = useState('');
  const [viewing, setViewing] = useState<ProgressJson | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await listProgress(todoId);
      setItems(result.items);
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [notify, todoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAdd = async () => {
    if (draft.trim() === '' || adding) return;
    setAdding(true);
    try {
      await addProgress(todoId, draft);
      setDraft('');
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (progress: ProgressJson) => {
    try {
      await updateProgressFinished(progress.id, !progress.isFinished);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const handleDelete = async (progress: ProgressJson) => {
    try {
      await deleteProgress(progress.id);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  return (
    <div className="todo-progress">
      <div className="todo-progress-header">
        <h3 className="todo-progress-heading">进度记录</h3>
        {items !== null && items.length > 0 && (
          <span>
            {items.filter((item) => item.isFinished).length} / {items.length} 已完成
          </span>
        )}
      </div>
      {items === null && (
        <p className="todo-loading" role="status">
          正在加载进度…
        </p>
      )}
      {items !== null && items.length === 0 && (
        <p className="todo-progress-empty">还没有进度记录。</p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="todo-progress-list">
          {items.map((progress) => (
            <li key={progress.id} className="todo-progress-item">
              <input
                type="checkbox"
                aria-label={progress.isFinished ? '标记未完成' : '标记完成'}
                checked={progress.isFinished}
                onChange={() => void handleToggle(progress)}
              />
              <button
                type="button"
                className={
                  progress.isFinished ? 'todo-progress-content done' : 'todo-progress-content'
                }
                title="查看全文"
                onClick={() => setViewing(progress)}
              >
                {progress.content}
              </button>
              <span className="todo-progress-meta">{formatDateTime(progress.createTime)}</span>
              <IconButton
                name="trash"
                label="删除进度"
                onClick={() => void handleDelete(progress)}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="todo-progress-add">
        <input
          aria-label="新增进度记录"
          disabled={adding}
          value={draft}
          placeholder="记录一条进度…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void handleAdd();
            }
          }}
        />
        <Button
          variant="secondary"
          disabled={adding || draft.trim() === ''}
          onClick={() => void handleAdd()}
        >
          {adding ? '添加中…' : '添加'}
        </Button>
      </div>
      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title="进度内容"
        feedback={viewing !== null ? `创建于 ${formatDateTime(viewing.createTime)}` : undefined}
      >
        <div className="todo-dialog-body">
          <p className="todo-progress-fulltext">{viewing?.content ?? ''}</p>
        </div>
      </Dialog>
    </div>
  );
}

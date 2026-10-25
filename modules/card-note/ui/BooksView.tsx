import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Icon, IconButton } from '@reisa/ui';
import {
  createBook,
  deleteBook,
  errorMessage,
  importBook,
  listBooks,
  pickPath,
  renameBook,
  type BookJson,
} from './client.ts';
import { formatTime } from './format.ts';
import { PromptDialog } from './PromptDialog.tsx';

/**
 * 笔记本列表（源 BookListPage，FR-01）：
 * updatedAt 倒序；创建/重命名/删除（级联警告）；同名笔记本允许并存；
 * JSON 导入作为新笔记本副本（源超出原 MVP 的实现，M4 移植）。
 */
export function BooksView({
  notify,
  onOpenBook,
  onOpenTags,
  onOpenSettings,
}: {
  notify: (message: string) => void;
  onOpenBook: (bookId: string) => void;
  onOpenTags: () => void;
  onOpenSettings: () => void;
}) {
  const [books, setBooks] = useState<BookJson[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<BookJson | null>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const visibleBooks = books?.filter((book) =>
    book.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      try {
        setBooks(await listBooks());
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

  const handleImport = async () => {
    const path = await pickPath('file', ['json']);
    if (path === null) return;
    setImporting(true);
    try {
      const result = await importBook(path);
      notify(`已导入「${result.title}」（${result.noteCount} 条笔记）`);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  const handleCreate = async (title: string) => {
    try {
      const book = await createBook(title);
      await refresh();
      onOpenBook(book.id);
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const handleRename = async (bookId: string, title: string) => {
    try {
      await renameBook(bookId, title);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const handleDelete = async (book: BookJson) => {
    if (
      !window.confirm(
        `删除笔记本「${book.title}」？\n其全部笔记、标签关联与附件将一并删除，且不可恢复。`,
      )
    ) {
      return;
    }
    try {
      await deleteBook(book.id);
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  return (
    <div className="card-note-view">
      <div className="card-note-library-tools">
        <div className="card-note-collection-label">
          <Icon name="book" size={17} />
          <strong>我的笔记本</strong>
          {books !== null && <span>{books.length}</span>}
        </div>
        <div className="card-note-search" role="search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索笔记本"
            value={query}
            placeholder="搜索笔记本名称…"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== '' && (
            <IconButton name="close" label="清空笔记本搜索" onClick={() => setQuery('')} />
          )}
        </div>
        <Button variant="ghost" onClick={onOpenTags}>
          标签管理
        </Button>
        <Button variant="ghost" disabled={importing} onClick={() => void handleImport()}>
          {importing ? '导入中…' : '导入笔记本'}
        </Button>
        <IconButton name="settings" label="模块设置" onClick={onOpenSettings} />
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} />
          新建笔记本
        </Button>
      </div>
      {books === null && (
        <p className="card-note-loading" role="status">
          正在加载笔记本…
        </p>
      )}
      {books !== null && books.length > 0 && visibleBooks?.length === 0 && (
        <EmptyState
          icon="search"
          title="没有找到这个笔记本"
          description="试试其他名称，或清空搜索查看全部笔记本。"
        >
          <Button onClick={() => setQuery('')}>清空搜索</Button>
        </EmptyState>
      )}

      {books !== null && books.length === 0 && (
        <EmptyState
          icon="book"
          title="还没有笔记本"
          description="创建一个笔记本，开始记录你的想法。"
        >
          <Button variant="primary" onClick={() => setCreating(true)}>
            创建笔记本
          </Button>
        </EmptyState>
      )}

      {books !== null && books.length > 0 && (
        <ul className="card-note-book-list">
          {visibleBooks?.map((book) => (
            <li key={book.id}>
              <button
                type="button"
                className="card-note-book-row"
                onClick={() => onOpenBook(book.id)}
              >
                <span className="card-note-book-cover" aria-hidden="true">
                  <Icon name="book" size={25} />
                </span>
                <span className="card-note-book-info">
                  <span className="card-note-book-title">{book.title}</span>
                  <span className="card-note-row-meta">更新于 {formatTime(book.updatedAt)}</span>
                </span>
              </button>
              <div className="card-note-row-actions">
                <IconButton
                  name="edit"
                  label={`重命名「${book.title}」`}
                  onClick={() => setRenaming(book)}
                />
                <IconButton
                  name="trash"
                  label={`删除「${book.title}」`}
                  onClick={() => void handleDelete(book)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <PromptDialog
        open={creating}
        title="创建笔记本"
        label="笔记本名称"
        placeholder="例如：读书摘记"
        confirmText="创建"
        onSubmit={handleCreate}
        onClose={() => setCreating(false)}
      />
      <PromptDialog
        open={renaming !== null}
        title="重命名笔记本"
        label="笔记本名称"
        initial={renaming?.title ?? ''}
        confirmText="保存"
        onSubmit={(title) => handleRename(renaming?.id ?? '', title)}
        onClose={() => setRenaming(null)}
      />
    </div>
  );
}

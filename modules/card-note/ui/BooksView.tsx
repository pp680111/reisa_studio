import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, IconButton, PageHeading } from '@reisa/ui';
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
 * 书籍列表（源 BookListPage，FR-01）：
 * updatedAt 倒序；创建/重命名/删除（级联警告）；同名书籍允许并存；
 * JSON 导入作为新书副本（源超出原 MVP 的实现，M4 移植）。
 */
export function BooksView({
  notify,
  onOpenBook,
  onOpenTags,
}: {
  notify: (message: string) => void;
  onOpenBook: (bookId: string) => void;
  onOpenTags: () => void;
}) {
  const [books, setBooks] = useState<BookJson[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<BookJson | null>(null);
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setBooks(await listBooks());
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [notify]);

  useEffect(() => {
    void refresh();
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
        `删除书籍「${book.title}」？\n其全部笔记、标签关联与附件将一并删除，且不可恢复。`,
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
      <PageHeading
        eyebrow="模块"
        title="卡片笔记"
        description="以书籍为容器整理阅读摘录、备注与页码。"
      >
        <Button disabled={importing} onClick={() => void handleImport()}>
          导入 JSON
        </Button>
        <Button onClick={onOpenTags}>标签管理</Button>
        <Button variant="primary" onClick={() => setCreating(true)}>
          创建书籍
        </Button>
      </PageHeading>

      {books !== null && books.length === 0 && (
        <EmptyState icon="book" title="还没有书籍" description="创建一本书，开始记录你的阅读笔记。">
          <Button variant="primary" onClick={() => setCreating(true)}>
            创建书籍
          </Button>
        </EmptyState>
      )}

      {books !== null && books.length > 0 && (
        <ul className="card-note-book-list">
          {books.map((book) => (
            <li key={book.id}>
              <button
                type="button"
                className="card-note-book-row"
                onClick={() => onOpenBook(book.id)}
              >
                <span className="card-note-book-title">{book.title}</span>
                <span className="card-note-row-meta">更新于 {formatTime(book.updatedAt)}</span>
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
        title="创建书籍"
        label="书名"
        placeholder="例如：设计心理学"
        confirmText="创建"
        onSubmit={handleCreate}
        onClose={() => setCreating(false)}
      />
      <PromptDialog
        open={renaming !== null}
        title="重命名书籍"
        label="书名"
        initial={renaming?.title ?? ''}
        confirmText="保存"
        onSubmit={(title) => handleRename(renaming?.id ?? '', title)}
        onClose={() => setRenaming(null)}
      />
    </div>
  );
}

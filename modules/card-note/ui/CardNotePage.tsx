import { useState } from 'react';
import type { ModulePageProps } from '@reisa/module-sdk';
import { BookDetailView } from './BookDetailView.tsx';
import { BooksView } from './BooksView.tsx';
import { NoteEditorView } from './NoteEditorView.tsx';
import { TagsView } from './TagsView.tsx';
import './CardNotePage.css';

/**
 * 卡片笔记工作区（module-ui-design §3：模块页面自带视图状态机，无 URL 路由）：
 * 书籍列表 → 书籍详情（列表/搜索） → 笔记编辑器，另有全局标签管理。
 * 数据一律经页面服务通道获取；刷新采用"操作后主动刷新 + 5 秒轮询"（决策 Q5，
 * 轮询覆盖克隆/同步导入与后台自动同步这类页面外变更；编辑器表单不轮询）。
 */

type View =
  | { name: 'books' }
  | { name: 'book'; bookId: string }
  | { name: 'editor'; bookId: string; noteId: string | null }
  | { name: 'tags' };

export function CardNotePage({ openSettings, notify }: ModulePageProps) {
  const [view, setView] = useState<View>({ name: 'books' });
  // 编辑器保存/删除后递增，触发书籍详情重新拉取（未来 M5 同步变更同样复用）。
  const [bookRefreshToken, setBookRefreshToken] = useState(0);

  return (
    <div className="card-note-page">
      {view.name === 'books' && (
        <BooksView
          notify={notify}
          onOpenBook={(bookId) => setView({ name: 'book', bookId })}
          onOpenTags={() => setView({ name: 'tags' })}
          onOpenSettings={openSettings}
        />
      )}
      {view.name === 'book' && (
        <BookDetailView
          key={view.bookId}
          bookId={view.bookId}
          notify={notify}
          refreshToken={bookRefreshToken}
          onBack={() => setView({ name: 'books' })}
          onOpenEditor={(noteId) => setView({ name: 'editor', bookId: view.bookId, noteId })}
        />
      )}
      {view.name === 'editor' && (
        <NoteEditorView
          key={view.noteId ?? 'new'}
          bookId={view.bookId}
          noteId={view.noteId}
          notify={notify}
          onBack={() => setView({ name: 'book', bookId: view.bookId })}
          onFinished={() => {
            setBookRefreshToken((token) => token + 1);
            setView({ name: 'book', bookId: view.bookId });
          }}
        />
      )}
      {view.name === 'tags' && (
        <TagsView notify={notify} onBack={() => setView({ name: 'books' })} />
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, EmptyState, Icon, IconButton, PageHeading, Tabs } from '@reisa/ui';
import {
  errorMessage,
  exportBookToFile,
  getBook,
  getNoteTags,
  listNotes,
  pickSavePath,
  previewExport,
  type ExportFormatJson,
  type NoteJson,
  type TagJson,
} from './client.ts';
import { formatTime, pageLabel } from './format.ts';

interface NoteRow {
  note: NoteJson;
  tags: TagJson[];
}

const VIEW_MODES = ['列表', '网格'] as const;

/**
 * 书籍详情（源 BookDetailPage，FR-08/FR-09/FR-11）：
 * 列表/卡片网格双视图（同一份查询结果；画板视图已随 R3 移除）+
 * 当前书籍内搜索（250ms 防抖，仅匹配原文与备注，两视图共用）。
 */
export function BookDetailView({
  bookId,
  notify,
  refreshToken,
  onBack,
  onOpenEditor,
}: {
  bookId: string;
  notify: (message: string) => void;
  refreshToken: number;
  onBack: () => void;
  onOpenEditor: (noteId: string | null) => void;
}) {
  const [title, setTitle] = useState<string | null>(null);
  const [rows, setRows] = useState<NoteRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [viewMode, setViewMode] = useState<'列表' | '网格'>('列表');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      try {
        const book = await getBook(bookId);
        if (book === null) {
          notify('书籍不存在或已被删除');
          onBack();
          return;
        }
        setTitle(book.title);
        const notes = await listNotes(bookId, debouncedQuery);
        const tagsPerNote = await Promise.all(notes.map((note) => getNoteTags(note.id)));
        setRows(notes.map((note, index) => ({ note, tags: tagsPerNote[index] ?? [] })));
      } catch (error) {
        if (options?.silent !== true) notify(errorMessage(error));
      }
    },
    [bookId, debouncedQuery, notify, onBack],
  );

  // Q5 刷新策略：操作后主动刷新 + 5 秒轮询；轮询承接页面外变更（克隆/同步导入、
  // 后台自动同步），失败时静默保留当前数据，避免错误提示重复弹出。
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh({ silent: true }), 5000);
    return () => clearInterval(timer);
  }, [refresh, refreshToken]);

  const handleExport = async (format: ExportFormatJson) => {
    setExportOpen(false);
    setExporting(true);
    try {
      const preview = await previewExport(bookId, format);
      const target = await pickSavePath(preview.suggestedFileName, [
        format === 'json' ? 'json' : 'md',
      ]);
      if (target === null) return;
      await exportBookToFile(bookId, format, target);
      notify(`已导出：${preview.suggestedFileName}`);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="card-note-view">
      <div className="card-note-toolbar">
        <Button variant="ghost" onClick={onBack}>
          ← 返回书籍
        </Button>
      </div>

      <PageHeading eyebrow="阅读笔记" title={title ?? '正在加载…'}>
        <Button disabled={exporting} onClick={() => setExportOpen(true)}>
          {exporting ? '导出中…' : '导出书籍'}
        </Button>
        <Button variant="primary" onClick={() => onOpenEditor(null)}>
          <Icon name="plus" size={16} /> 新建笔记
        </Button>
      </PageHeading>

      <div className="card-note-library-tools">
        <span className="card-note-result-count" role="status">
          {rows === null
            ? '正在加载…'
            : `${debouncedQuery.trim() === '' ? '共' : '找到'} ${rows.length} 条笔记`}
        </span>
        <div className="card-note-search" role="search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索本书笔记"
            value={query}
            placeholder="搜索本书笔记的原文与备注"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== '' && (
            <IconButton name="close" label="清空搜索" onClick={() => setQuery('')} />
          )}
        </div>
        <Tabs
          items={VIEW_MODES}
          value={viewMode}
          onChange={(value) => setViewMode(value === '网格' ? '网格' : '列表')}
        />
      </div>

      {rows !== null && rows.length === 0 && debouncedQuery.trim() !== '' && (
        <EmptyState
          icon="search"
          title="没有匹配的笔记"
          description={`当前书籍内没有原文或备注包含「${debouncedQuery.trim()}」。`}
        >
          <Button onClick={() => setQuery('')}>清空搜索</Button>
        </EmptyState>
      )}
      {rows !== null && rows.length === 0 && debouncedQuery.trim() === '' && (
        <EmptyState
          icon="document"
          title="还没有笔记"
          description="新建一张笔记卡片，记录书中的摘录与想法。"
        >
          <Button variant="primary" onClick={() => onOpenEditor(null)}>
            新建笔记
          </Button>
        </EmptyState>
      )}

      {rows !== null && rows.length > 0 && viewMode === '列表' && (
        <ul className="card-note-note-list">
          {rows.map(({ note, tags }) => (
            <li key={note.id}>
              <button
                type="button"
                className="card-note-note-row"
                onClick={() => onOpenEditor(note.id)}
              >
                <NoteSummary note={note} tags={tags} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {rows !== null && rows.length > 0 && viewMode === '网格' && (
        <div className="card-note-grid">
          {rows.map(({ note, tags }) => (
            <button
              key={note.id}
              type="button"
              className="card-note-grid-card"
              onClick={() => onOpenEditor(note.id)}
            >
              <NoteSummary note={note} tags={tags} compact />
            </button>
          ))}
        </div>
      )}

      <Dialog open={exportOpen} onClose={() => setExportOpen(false)} title="导出书籍">
        <div className="card-note-export">
          <p className="card-note-export-hint">
            导出内容仅包含当前书籍的笔记（按创建时间从早到晚），不含链接与附件。
          </p>
          <Button disabled={exporting} onClick={() => void handleExport('markdown')}>
            Markdown（.md）
          </Button>
          <Button disabled={exporting} onClick={() => void handleExport('json')}>
            JSON（.json，保留 ID、页码、标签与内容版本）
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** 笔记摘要内容（列表行与网格卡片共用；FR-08/FR-09 要求的最小展示集）。 */
function NoteSummary({
  note,
  tags,
  compact = false,
}: {
  note: NoteJson;
  tags: TagJson[];
  compact?: boolean;
}) {
  return (
    <>
      <p className={compact ? 'card-note-quote compact' : 'card-note-quote'}>{note.quote}</p>
      {note.comment !== null && note.comment.trim() !== '' && (
        <p className="card-note-comment">{note.comment}</p>
      )}
      <div className="card-note-note-meta">
        <Badge>{pageLabel(note.pageStart, note.pageEnd)}</Badge>
        {tags.map((tag) => (
          <span key={tag.id} className="card-note-tag">
            {tag.name}
          </span>
        ))}
        <span className="card-note-row-meta">保存于 {formatTime(note.updatedAt)}</span>
      </div>
    </>
  );
}

import { useRef, useState } from 'react';
import { EmptyState, IconButton } from '@reisa/ui';
import { tabularTextToMarkdown } from '../domain/markdown.ts';
import { MarkdownPreview } from './MarkdownPreview.tsx';

/**
 * Markdown 编辑器（原文摘录与笔记正文共用；自 NoteEditorView 原文区抽取）：
 * 工具栏 + 编辑/预览切换（GFM 与 KaTeX 公式）、TSV 粘贴转表格。纯受控组件。
 * 复用 CardNotePage.css 的 card-note-md-* 样式。
 */

const MARKDOWN_TOOLBAR: ReadonlyArray<{
  icon: string;
  label: string;
  prefix: string;
  suffix: string;
  placeholder: string;
}> = [
  { icon: 'heading', label: '标题', prefix: '## ', suffix: '', placeholder: '标题' },
  { icon: 'bold', label: '粗体', prefix: '**', suffix: '**', placeholder: '粗体文字' },
  { icon: 'italic', label: '斜体', prefix: '*', suffix: '*', placeholder: '斜体文字' },
  { icon: 'quote', label: '引用', prefix: '> ', suffix: '', placeholder: '引用内容' },
  { icon: 'list', label: '无序列表', prefix: '- ', suffix: '', placeholder: '列表项' },
  { icon: 'link', label: '链接', prefix: '[', suffix: '](https://)', placeholder: '链接文字' },
  {
    icon: 'table',
    label: '表格',
    prefix: '',
    suffix: '',
    placeholder: '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |',
  },
  { icon: 'code', label: '代码块', prefix: '```\n', suffix: '\n```', placeholder: '代码' },
];

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
  rows = 9,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  rows?: number;
}) {
  const [mode, setMode] = useState('编辑');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const insertMarkdown = (prefix: string, suffix: string, fill: string) => {
    const element = inputRef.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const content = selected === '' ? fill : selected;
    onChange(value.slice(0, start) + prefix + content + suffix + value.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + prefix.length, start + prefix.length + content.length);
    });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const source = event.clipboardData.getData('text/plain');
    if (source === '') return;
    const converted = tabularTextToMarkdown(source);
    if (converted === null) return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + converted + value.slice(end));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + converted.length, start + converted.length);
    });
  };

  return (
    <div className="card-note-md-editor">
      <div className="card-note-md-tools">
        <div className="card-note-markdown-toolbar" aria-label="Markdown 工具栏">
          {MARKDOWN_TOOLBAR.map((item) => (
            <IconButton
              key={item.label}
              name={item.icon}
              label={item.label}
              disabled={mode !== '编辑'}
              onClick={() => insertMarkdown(item.prefix, item.suffix, item.placeholder)}
            />
          ))}
        </div>
        <div className="card-note-md-tabs" role="group" aria-label={`${ariaLabel}视图`}>
          <button
            type="button"
            className={mode === '编辑' ? 'active' : ''}
            aria-pressed={mode === '编辑'}
            onClick={() => setMode('编辑')}
          >
            编辑
          </button>
          <button
            type="button"
            className={mode === '预览' ? 'active' : ''}
            aria-pressed={mode === '预览'}
            onClick={() => setMode('预览')}
          >
            预览
          </button>
        </div>
      </div>

      {mode === '编辑' ? (
        <textarea
          ref={inputRef}
          className="card-note-md-input"
          aria-label={ariaLabel}
          rows={rows}
          value={value}
          placeholder={placeholder}
          onPaste={handlePaste}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="card-note-md-preview">
          {value.trim() === '' ? (
            <EmptyState
              icon="document"
              title="暂无内容"
              description="内容为空，切回编辑模式填写。"
            />
          ) : (
            <MarkdownPreview source={value} />
          )}
        </div>
      )}
    </div>
  );
}

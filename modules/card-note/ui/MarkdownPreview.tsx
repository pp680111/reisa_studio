import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/**
 * 原文 Markdown 预览（源 LatexMarkdownBody 的对应物）：
 * GFM（表格/任务列表/删除线）+ KaTeX 行内/块级公式（决策 Q8：全量 katex）。
 */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className="card-note-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

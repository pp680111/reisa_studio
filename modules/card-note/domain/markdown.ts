/**
 * Markdown 工具（迁移自 card_note `lib/features/notes/domain/markdown_text.dart`）。
 * markdownToPlainText（AI 提示词用）随 R2 移除；仅保留编辑器粘贴的表格转换。
 */

/** 把制表符分隔的纯文本转成 Markdown 表格；非表格输入返回 null（源 tabularTextToMarkdown）。 */
export function tabularTextToMarkdown(source: string): string | null {
  const lines = source
    .trimRight()
    .split(/\r?\n/)
    .filter((line) => line !== '');
  if (lines.length < 2 || lines.some((line) => !line.includes('\t'))) {
    return null;
  }
  const rows = lines.map((line) => line.split('\t'));
  const columnCount = rows[0]?.length ?? 0;
  if (columnCount < 2 || rows.some((row) => row.length !== columnCount)) {
    return null;
  }
  const renderRow = (cells: string[]): string =>
    `| ${cells.map((cell) => cell.trim().replaceAll('|', '\\|')).join(' | ')} |`;
  return [
    renderRow(rows[0] ?? []),
    renderRow(Array.from({ length: columnCount }, () => '---')),
    ...rows.slice(1).map(renderRow),
  ].join('\n');
}

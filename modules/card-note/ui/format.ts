/** 列表/详情展示的小工具（与源项目 _pageLabel、时间展示语义一致）。 */

export function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function pageLabel(start: number | null, end: number | null): string {
  if (start === null) return '未填写';
  if (start === end) return `第 ${start} 页`;
  return `第 ${start}-${end} 页`;
}

/** 时间展示（源 DateTimeUtils/intl DateFormat 的对应物）；输入一律为 UTC 毫秒。 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDateTime(ms: number | null): string {
  if (ms === null) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

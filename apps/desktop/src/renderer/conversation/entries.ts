/**
 * 会话条目合成（纯函数，无 React 依赖）：持久化消息与工具记录 → 展示条目。
 * 独立成模块以便单元测试覆盖历史失败状态的还原。
 */
import type { ToolStatus } from './ToolCallRecord';
import type { ReisaMessage } from '../bridge';

/** 用户消息中附件块的起始分隔符（由主进程合成，见 conversation-manager）。 */
export const ATTACHMENT_DELIMITER = '--- 附件：';

/** 用户消息展示：截去附件内联内容，只显示正文与附件摘要。 */
export function displayUserText(text: string): string {
  const cut = text.indexOf(`\n\n${ATTACHMENT_DELIMITER}`);
  const head = cut === -1 ? text : text.slice(0, cut);
  const names =
    cut === -1 ? [] : [...text.slice(cut).matchAll(/--- 附件：(.+?) ---/g)].map((m) => m[1]);
  if (names.length === 0) return head;
  return `${head}\n附件：${names.join('、')}`;
}

export type Entry =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string }
  | {
      kind: 'tool';
      toolCallId: string;
      toolName: string;
      status: ToolStatus;
      input?: unknown;
      output?: unknown;
      error?: string;
    };

function unwrapOutput(output: unknown): unknown {
  if (
    output &&
    typeof output === 'object' &&
    (output as { type?: unknown }).type === 'json' &&
    'value' in output
  ) {
    return (output as { value: unknown }).value;
  }
  return output;
}

/** 工具记录通道的最小形态（reisa/conversations/toolRecords 返回，按调用 ID 关联）。 */
export interface ToolRecordSummary {
  readonly invocationId: string;
  readonly status: string;
  readonly errorCode?: string;
}

/** 持久化失败工具的结果为 error-text / error-json 信封（框架 createToolModelOutput），取出可展示文案。 */
function persistedError(output: unknown): string | undefined {
  const type = output && typeof output === 'object' ? (output as { type?: unknown }).type : null;
  if (type !== 'error-text' && type !== 'error-json') return undefined;
  const value = (output as { value?: unknown }).value;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 持久化消息 → 展示条目：工具调用按配对的 tool-result 还原状态；
 * 持久化 part 不带失败信息时用工具记录兜底判定（按 toolCallId 关联）。
 */
export function messagesToEntries(
  messages: ReisaMessage[],
  toolRecords: readonly ToolRecordSummary[] = [],
): Entry[] {
  const failedCalls = new Set(
    toolRecords.filter((record) => record.status === 'error').map((record) => record.invocationId),
  );
  const entries: Entry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) entries.push({ kind: 'text', role: 'user', text: displayUserText(text) });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    if (message.role === 'assistant') {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
      if (text) entries.push({ kind: 'text', role: 'assistant', text });
      for (const part of message.content) {
        if (part.type === 'tool-call' && part.toolCallId) {
          entries.push({
            kind: 'tool',
            toolCallId: String(part.toolCallId),
            toolName: String(part.toolName ?? ''),
            status: 'completed',
            input: part.input,
          });
        }
      }
    }
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result' && part.toolCallId) {
          const entry = [...entries]
            .reverse()
            .find((item) => item.kind === 'tool' && item.toolCallId === part.toolCallId);
          if (!entry || entry.kind !== 'tool') continue;
          const error = persistedError(part.output);
          if (error !== undefined) {
            entry.status = 'failed';
            entry.error = error;
          } else if (failedCalls.has(String(part.toolCallId))) {
            const record = toolRecords.find(
              (item) => item.invocationId === part.toolCallId && item.status === 'error',
            );
            entry.status = 'failed';
            entry.error = record?.errorCode ? `${record.errorCode}: 工具调用失败` : '工具调用失败';
          } else {
            entry.output = unwrapOutput(part.output);
          }
        }
      }
    }
  }
  return entries;
}

/**
 * 待办状态枚举（迁移自 todo_manage `lib/model/todo_thing/todo_thing_state.dart`）。
 * key 与源库一致（0–3），旧库导入无需映射（迁移设计文档附录 A）；
 * EXPIRED 无自动赋值逻辑，只能经能力/表单手工设置（决策 Q4：保持源行为）。
 */

export const TODO_STATE_NOT_START = 0;
export const TODO_STATE_EXECUTING = 1;
export const TODO_STATE_FINISHED = 2;
export const TODO_STATE_EXPIRED = 3;

export interface TodoStateValue {
  readonly key: TodoStatusKey;
  readonly name: string;
  readonly text: string;
}

export type TodoStatusKey = 0 | 1 | 2 | 3;

/** 状态表：顺序即详情表单状态下拉的展示顺序（与源 TodoThingState.values 一致）。 */
export const TODO_STATES: readonly TodoStateValue[] = [
  { key: TODO_STATE_NOT_START, name: 'NOT_START', text: '未开始' },
  { key: TODO_STATE_EXECUTING, name: 'EXECUTING', text: '执行中' },
  { key: TODO_STATE_FINISHED, name: 'FINISHED', text: '已完成' },
  { key: TODO_STATE_EXPIRED, name: 'EXPIRED', text: '已超时' },
];

const STATE_BY_KEY = new Map<number, TodoStateValue>(
  TODO_STATES.map((state) => [state.key, state]),
);

/** 反查状态；未知 key 抛错（源 fromKey 的 ArgumentError 对应物）。 */
export function todoStateFromKey(key: number): TodoStateValue {
  const state = STATE_BY_KEY.get(key);
  if (state === undefined) {
    throw new RangeError(`未知的待办状态：${key}`);
  }
  return state;
}

export function todoStateText(key: number): string {
  return todoStateFromKey(key).text;
}

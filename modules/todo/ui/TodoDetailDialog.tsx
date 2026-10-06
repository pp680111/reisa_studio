import { useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Icon } from '@reisa/ui';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { TODO_STATES } from '../domain/todo-state.ts';
import { errorMessage, getTodo, saveTodo, type CategoryJson, type TodoStatus } from './client.ts';
import { formatDateTime } from './format.ts';
import { CategorySelectDialog } from './CategorySelectDialog.tsx';
import { ProgressSection } from './ProgressSection.tsx';

const WEEKDAY_LABELS: Record<string, string> = {
  Sunday: '日',
  Monday: '一',
  Tuesday: '二',
  Wednesday: '三',
  Thursday: '四',
  Friday: '五',
  Saturday: '六',
};

/**
 * 待办详情/编辑弹窗（源 TodoThingDetail 的弹窗化对应物）：
 * 状态下拉仅编辑态（源 insertMode 语义）；新建固定未开始（§5.2）；
 * 分类经弹窗选择；截止时间用第三方日期时间选择器（Q5）；编辑态内嵌进度区块。
 */
export function TodoDetailDialog({
  todoId,
  notify,
  onFinished,
}: {
  todoId: number | null;
  notify: (message: string) => void;
  onFinished: (changed: boolean) => void;
}) {
  const isEdit = todoId !== null;
  const [loading, setLoading] = useState(isEdit);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [status, setStatus] = useState<TodoStatus>(0);
  const [category, setCategory] = useState<CategoryJson | null>(null);
  const [deadline, setDeadline] = useState<Date | null>(null);
  const [createTime, setCreateTime] = useState<number | null>(null);
  const [selectingCategory, setSelectingCategory] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (todoId === null) return;
    let cancelled = false;
    getTodo(todoId)
      .then((todo) => {
        if (cancelled || todo === null) {
          if (!cancelled && todo === null) {
            notify('待办不存在或已被删除');
            onFinished(false);
          }
          return;
        }
        setTitle(todo.title);
        setDetail(todo.detail ?? '');
        setStatus(todo.status);
        setCreateTime(todo.createTime);
        setDeadline(todo.deadlineTime === null ? null : new Date(todo.deadlineTime));
        setCategory(
          todo.categoryId === null
            ? null
            : { id: todo.categoryId, name: todo.categoryName ?? '', createTime: 0, updateTime: 0 },
        );
        setLoading(false);
      })
      .catch((error) => {
        if (!cancelled) {
          notify(errorMessage(error));
          onFinished(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [notify, onFinished, todoId]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() === '') {
      notify('标题不得为空');
      return;
    }
    setSaving(true);
    try {
      await saveTodo({
        todoId,
        title,
        detail: detail.trim() === '' ? null : detail,
        status: isEdit ? status : null,
        categoryId: category?.id ?? null,
        deadlineTime: deadline === null ? null : deadline.getTime(),
      });
      notify('保存成功');
      onFinished(true);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onFinished(false);
      }}
      title={isEdit ? '待办详情' : '新建待办'}
      wide
    >
      <div className="todo-dialog-body">
        {loading ? (
          <p className="todo-loading" role="status">
            正在加载待办…
          </p>
        ) : (
          <form
            className="todo-form"
            onSubmit={(event) => void handleSubmit(event)}
            aria-busy={saving}
          >
            <Field label="标题">
              <input
                value={title}
                placeholder="要做什么？"
                autoFocus
                required
                disabled={saving}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label="详情（可选）">
              <textarea
                value={detail}
                rows={3}
                placeholder="补充说明、链接或备注…"
                disabled={saving}
                onChange={(event) => setDetail(event.target.value)}
              />
            </Field>
            <div className="todo-form-grid">
              {isEdit && (
                <Field label="状态">
                  <select
                    disabled={saving}
                    value={status}
                    onChange={(event) => setStatus(Number(event.target.value) as TodoStatus)}
                  >
                    {TODO_STATES.map((state) => (
                      <option key={state.key} value={state.key}>
                        {state.text}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="分类">
                <button
                  type="button"
                  className="todo-category-input"
                  disabled={saving}
                  onClick={() => setSelectingCategory(true)}
                  title="点击选择分类"
                >
                  <span>
                    <Icon name="folder" size={16} />
                    {category?.name ?? '未分类'}
                  </span>
                  <Icon name="chevronDown" size={14} />
                </button>
              </Field>
              <Field label="截止时间">
                <DatePicker
                  id="todo-deadline"
                  disabled={saving}
                  selected={deadline}
                  onChange={(date) => setDeadline(date)}
                  showTimeSelect
                  timeFormat="HH:mm"
                  timeCaption="时间"
                  formatWeekDay={(day) => WEEKDAY_LABELS[day] ?? day}
                  clearButtonTitle="清除截止时间"
                  renderCustomHeader={({
                    date,
                    decreaseMonth,
                    increaseMonth,
                    prevMonthButtonDisabled,
                    nextMonthButtonDisabled,
                  }) => (
                    <div className="todo-calendar-heading">
                      <button
                        type="button"
                        aria-label="上一月"
                        disabled={prevMonthButtonDisabled}
                        onClick={decreaseMonth}
                      >
                        <Icon name="chevronRight" size={16} className="todo-calendar-previous" />
                      </button>
                      <span>
                        {date.getFullYear()} 年 {date.getMonth() + 1} 月
                      </span>
                      <button
                        type="button"
                        aria-label="下一月"
                        disabled={nextMonthButtonDisabled}
                        onClick={increaseMonth}
                      >
                        <Icon name="chevronRight" size={16} />
                      </button>
                    </div>
                  )}
                  dateFormat="yyyy-MM-dd HH:mm"
                  placeholderText="不设置"
                  isClearable
                />
              </Field>
            </div>
            {isEdit && createTime !== null && (
              <p className="todo-created-at">创建于 {formatDateTime(createTime)}</p>
            )}
            {isEdit && todoId !== null && <ProgressSection todoId={todoId} notify={notify} />}
            <div className="todo-dialog-actions">
              <Button variant="ghost" disabled={saving} onClick={() => onFinished(false)}>
                取消
              </Button>
              <Button variant="primary" type="submit" disabled={saving || title.trim() === ''}>
                {saving ? '保存中…' : isEdit ? '保存修改' : '创建待办'}
              </Button>
            </div>
          </form>
        )}
      </div>
      {selectingCategory && (
        <CategorySelectDialog
          open
          selectedId={category?.id ?? null}
          onPick={(picked) => setCategory(picked)}
          onClose={() => setSelectingCategory(false)}
        />
      )}
    </Dialog>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, Field } from '@reisa/ui';

/**
 * 单字段输入弹窗（源新建/重命名分类与进度表单的通用对应物）。
 */
export function PromptDialog({
  open,
  title,
  label,
  initial = '',
  placeholder,
  confirmText,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmText: string;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || value.trim() === '') return;
    setSaving(true);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch {
      // 调用方展示错误；保留输入以便修改后重试。
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={title}
    >
      <form className="todo-prompt-form" onSubmit={(event) => void handleSubmit(event)}>
        <Field label={label}>
          <input
            value={value}
            placeholder={placeholder}
            autoFocus
            required
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <div className="todo-dialog-actions">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" type="submit" disabled={saving || value.trim() === ''}>
            {saving ? '保存中…' : confirmText}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

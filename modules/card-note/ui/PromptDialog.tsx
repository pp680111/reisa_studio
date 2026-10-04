import { useEffect, useState } from 'react';
import { Button, Dialog, Field } from '@reisa/ui';

/** 单字段文本输入对话框（创建/重命名书籍与标签共用）。 */
export function PromptDialog({
  open,
  title,
  label,
  hint,
  initial = '',
  placeholder,
  confirmText = '确定',
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  hint?: string;
  initial?: string;
  placeholder?: string;
  confirmText?: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initial);
      setBusy(false);
    }
  }, [open, initial]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit(value.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="card-note-prompt">
        <Field label={label} hint={hint}>
          <input
            value={value}
            placeholder={placeholder}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </Field>
        <div className="card-note-prompt-footer">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy || value.trim() === ''}
            onClick={() => void submit()}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

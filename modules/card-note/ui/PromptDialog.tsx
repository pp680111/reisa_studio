import { useEffect, useState } from 'react';
import { Button, Dialog, Field } from '@reisa/ui';

/** 可选第二字段（如笔记本备注）：多行文本，可留空。 */
export interface PromptSecondaryField {
  label: string;
  placeholder?: string;
  initial?: string;
}

/** 单字段文本输入对话框（创建/编辑笔记本与标签共用）；secondary 提供时追加多行第二字段。 */
export function PromptDialog({
  open,
  title,
  label,
  hint,
  initial = '',
  placeholder,
  confirmText = '确定',
  secondary,
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
  secondary?: PromptSecondaryField;
  onSubmit: (value: string, secondaryValue: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [secondaryValue, setSecondaryValue] = useState(secondary?.initial ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initial);
      setSecondaryValue(secondary?.initial ?? '');
      setBusy(false);
    }
    // 依赖 secondary.initial 取值而非对象本身：调用方通常内联构造 secondary 字面量。
  }, [open, initial, secondary?.initial]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit(value.trim(), secondaryValue.trim());
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
        {secondary && (
          <Field label={secondary.label}>
            <textarea
              value={secondaryValue}
              placeholder={secondary.placeholder}
              rows={4}
              onChange={(event) => setSecondaryValue(event.target.value)}
            />
          </Field>
        )}
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

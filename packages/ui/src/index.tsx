import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Copy,
  File,
  FileText,
  Folder,
  Grid2X2,
  History,
  Image,
  Layers,
  List,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Trash2,
  Upload,
  X,
  Languages,
  Moon,
  Sun,
  Monitor,
  type LucideIcon,
} from 'lucide-react';

const icons: Record<string, LucideIcon> = {
  arrowDown: ArrowDown,
  arrowUp: ArrowUp,
  arrowRight: ArrowRight,
  swap: ArrowLeftRight,
  book: BookOpen,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  select: ChevronsUpDown,
  help: CircleHelp,
  copy: Copy,
  file: File,
  document: FileText,
  folder: Folder,
  grid: Grid2X2,
  history: History,
  image: Image,
  layers: Layers,
  list: List,
  loading: LoaderCircle,
  chat: MessageSquare,
  more: MoreHorizontal,
  collapse: PanelLeftClose,
  expand: PanelLeftOpen,
  result: PanelRight,
  attach: Paperclip,
  edit: Pencil,
  pin: Pin,
  plus: Plus,
  search: Search,
  send: Send,
  settings: Settings,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  stop: Square,
  star: Star,
  trash: Trash2,
  upload: Upload,
  close: X,
  translation: Languages,
  moon: Moon,
  sun: Sun,
  monitor: Monitor,
};
export function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const Component = icons[name] ?? Layers;
  return <Component size={size} strokeWidth={1.7} className={className} aria-hidden="true" />;
}
export function Button({
  children,
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return (
    <button type="button" className={`button ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function IconButton({
  name,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { name: string; label: string }) {
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} {...props}>
      <Icon name={name} />
    </button>
  );
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-symbol">
        <Icon name={icon} size={28} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="tabs" aria-label="页面视图">
      {items.map((item) => (
        <button
          type="button"
          key={item}
          aria-pressed={value === item}
          className={value === item ? 'active' : ''}
          onClick={() => onChange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
  group = false,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  group?: boolean;
}) {
  return group ? (
    <fieldset className="field field-group">
      <legend>{label}</legend>
      {children}
      {hint && <small>{hint}</small>}
    </fieldset>
  ) : (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
  feedback,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  feedback?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'wide' : ''}`}
      onCancel={onClose}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            onClose();
        }
      }}
      aria-label={title}
    >
      <div className="dialog-header">
        <h2>{title}</h2>
        <IconButton name="close" label="关闭面板" onClick={onClose} />
      </div>
      {children}
      {open && feedback && (
        <div className="dialog-feedback" role="status">
          {feedback}
        </div>
      )}
    </dialog>
  );
}
/** This is a UI placeholder, never a success or runtime execution result. */
export function pending(notify: (message: string) => void, action: string) {
  notify(`${action}尚未接入；当前为界面预览，未执行实际操作。`);
}

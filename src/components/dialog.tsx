import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  sheet = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const previous = document.activeElement as HTMLElement | null;
      dialog.showModal();
      return () => {
        if (dialog.open) dialog.close();
        previous?.focus?.();
      };
    }
    if (!open && dialog.open) dialog.close();
    return undefined;
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className={`dialog${sheet ? ' sheet' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCloseRef.current();
      }}
    >
      <div className="dialog-head">
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        <button type="button" className="icon-btn" aria-label="Fechar" onClick={() => onCloseRef.current()}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <div className="dialog-body">
        {description && (
          <div id={descId} className="muted" style={{ marginBottom: 12 }}>
            {description}
          </div>
        )}
        {children}
      </div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  danger,
  requireText,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireText?: string;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const ok = !requireText || typed.trim().toUpperCase() === requireText.toUpperCase();
  return (
    <Dialog
      open={open}
      onClose={() => {
        setTyped('');
        onClose();
      }}
      title={title}
      footer={
        <>
          <Button
            onClick={() => {
              setTyped('');
              onClose();
            }}
          >
            Cancelar
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!ok}
            busy={busy}
            onClick={async () => {
              await onConfirm();
              setTyped('');
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div>{message}</div>
        {requireText && (
          <div className="field">
            <label className="field-label" htmlFor={inputId}>
              Para confirmar, digite {requireText}
            </label>
            <input id={inputId} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        )}
      </div>
    </Dialog>
  );
}

export interface SheetAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

export function ActionSheet({ open, onClose, title, actions, description }: { open: boolean; onClose: () => void; title: string; actions: SheetAction[]; description?: ReactNode }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <ul className="action-list">
        {actions
          .filter((a) => !a.hidden)
          .map((a) => (
            <li key={a.label}>
              <button
                type="button"
                className={a.danger ? 'is-danger' : undefined}
                onClick={() => {
                  onClose();
                  a.onSelect();
                }}
              >
                {a.icon}
                {a.label}
              </button>
            </li>
          ))}
      </ul>
    </Dialog>
  );
}

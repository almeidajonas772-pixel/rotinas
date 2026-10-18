import { ChevronLeft, CircleAlert, CircleCheck, Info, RotateCcw, TriangleAlert } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { Link } from 'react-router';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'md' | 'sm';
  icon?: ReactNode;
  block?: boolean;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, block, busy, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', block ? 'btn-block' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {icon}
      {children}
    </button>
  );
});

export function ButtonLink({ to, variant = 'secondary', size = 'md', icon, children, block }: { to: string; variant?: Variant; size?: 'md' | 'sm'; icon?: ReactNode; children: ReactNode; block?: boolean }) {
  const cls = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', block ? 'btn-block' : ''].filter(Boolean).join(' ');
  return (
    <Link to={to} className={cls}>
      {icon}
      {children}
    </Link>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button type={type} className="icon-btn" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <>
      {back && (
        <Link to={back.to} className="back-link">
          <ChevronLeft size={18} aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <header className="page-header">
        <div className="grow">
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="btn-row">{actions}</div>}
      </header>
    </>
  );
}

export function Section({ title, action, children, id, description }: { title: ReactNode; action?: ReactNode; children: ReactNode; id?: string; description?: ReactNode }) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className="section" aria-labelledby={headingId}>
      <div className="section-header">
        <h2 className="section-title" id={headingId}>
          {title}
        </h2>
        {action}
      </div>
      {description && <p className="meta" style={{ marginTop: -6, marginBottom: 12 }}>{description}</p>}
      {children}
    </section>
  );
}

type Tone = 'info' | 'warn' | 'danger' | 'ok' | 'neutral';

const TONE_ICON: Record<Tone, ReactNode> = {
  info: <Info size={18} aria-hidden="true" />,
  warn: <TriangleAlert size={18} aria-hidden="true" />,
  danger: <CircleAlert size={18} aria-hidden="true" />,
  ok: <CircleCheck size={18} aria-hidden="true" />,
  neutral: <Info size={18} aria-hidden="true" />,
};

export function Notice({ tone = 'info', title, children, action, role }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div className={`notice is-${tone}`} role={role}>
      {TONE_ICON[tone]}
      <div className="notice-body grow">
        {title && <p className="notice-title">{title}</p>}
        {children && <div>{children}</div>}
        {action && <div className="btn-row" style={{ marginTop: 6 }}>{action}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && (
        <span className="empty-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <p className="empty-title">{title}</p>
      {children && <div className="prose">{children}</div>}
      {action && <div className="btn-row">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Carregando…', lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ title = 'Algo não carregou', message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <Notice
      tone="danger"
      title={title}
      role="alert"
      action={
        onRetry ? (
          <Button size="sm" icon={<RotateCcw size={16} aria-hidden="true" />} onClick={onRetry}>
            Tentar de novo
          </Button>
        ) : undefined
      }
    >
      {message}
    </Notice>
  );
}

export function Tag({ tone, children, title }: { tone?: 'accent' | 'warn' | 'ok' | 'danger'; children: ReactNode; title?: string }) {
  return (
    <span className={`tag${tone ? ` is-${tone}` : ''}`} title={title}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, max, label, valueText }: { value: number; max: number; label: string; valueText?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={valueText}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}

export function Explain({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="explain">
      <summary>
        <Info size={16} aria-hidden="true" />
        {summary}
      </summary>
      <div className="prose">{children}</div>
    </details>
  );
}

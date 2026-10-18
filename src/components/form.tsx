import { CircleAlert } from 'lucide-react';
import { useId, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { IsoWeekday } from '../domain/civil';

interface FieldBase {
  label: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  id?: string;
}

function useField(props: FieldBase) {
  const auto = useId();
  const id = props.id ?? auto;
  const hintId = props.hint ? `${id}-hint` : undefined;
  const errorId = props.error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return { id, hintId, errorId, describedBy };
}

function Shell({ label, hint, error, optional, ids, children }: FieldBase & { ids: ReturnType<typeof useField>; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={ids.id}>
        {label}
        {optional && <span className="field-optional"> (opcional)</span>}
      </label>
      {hint && (
        <p id={ids.hintId} className="field-hint">
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p id={ids.errorId} className="field-error">
          <CircleAlert size={14} aria-hidden="true" style={{ marginTop: 2 }} />
          {error}
        </p>
      )}
    </div>
  );
}

type TextProps = FieldBase & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'> & { value: string; onChange: (value: string) => void };

export function TextField({ label, hint, error, optional, id, value, onChange, type = 'text', ...rest }: TextProps) {
  const ids = useField({ label, hint, error, id });
  return (
    <Shell label={label} hint={hint} error={error} optional={optional} ids={ids}>
      <input
        id={ids.id}
        className="input"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        {...rest}
      />
    </Shell>
  );
}

type AreaProps = FieldBase & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value' | 'id'> & { value: string; onChange: (value: string) => void; inputClassName?: string };

export function TextArea({ label, hint, error, optional, id, value, onChange, inputClassName, ...rest }: AreaProps) {
  const ids = useField({ label, hint, error, id });
  return (
    <Shell label={label} hint={hint} error={error} optional={optional} ids={ids}>
      <textarea
        id={ids.id}
        className={`textarea${inputClassName ? ` ${inputClassName}` : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        {...rest}
      />
    </Shell>
  );
}

type SelectProps = FieldBase &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'id'> & {
    value: string;
    onChange: (value: string) => void;
    options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
  };

export function SelectField({ label, hint, error, optional, id, value, onChange, options, ...rest }: SelectProps) {
  const ids = useField({ label, hint, error, id });
  return (
    <Shell label={label} hint={hint} error={error} optional={optional} ids={ids}>
      <select
        id={ids.id}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <div className="switch-text">
        <span className="switch-label" id={`${id}-label`}>
          {label}
        </span>
        {description && (
          <span className="meta" id={`${id}-desc`}>
            {description}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function CheckField({ label, description, checked, onChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="check-text">
        <span className="check-title">{label}</span>
        {description && <span className="meta">{description}</span>}
      </span>
    </label>
  );
}

/** Grupo de opções exclusivas (radiogroup) com navegação por setas. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  hideLabel,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hideLabel?: boolean;
}) {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = options.length;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (index + 1) % n
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (index - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className="field">
      <span id={`${id}-label`} className={hideLabel ? 'visually-hidden' : 'field-label'}>
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`${id}-label`}>
        {options.map((o, i) => (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const WEEKDAYS: Array<{ value: IsoWeekday; short: string; long: string }> = [
  { value: 1, short: 'Seg', long: 'segunda-feira' },
  { value: 2, short: 'Ter', long: 'terça-feira' },
  { value: 3, short: 'Qua', long: 'quarta-feira' },
  { value: 4, short: 'Qui', long: 'quinta-feira' },
  { value: 5, short: 'Sex', long: 'sexta-feira' },
  { value: 6, short: 'Sáb', long: 'sábado' },
  { value: 7, short: 'Dom', long: 'domingo' },
];

export function WeekdayPicker({ label, value, onChange, error, hint }: { label: string; value: number[]; onChange: (days: number[]) => void; error?: string; hint?: string }) {
  const id = useId();
  return (
    <fieldset aria-describedby={[hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined}>
      <legend>{label}</legend>
      {hint && (
        <p className="field-hint" id={`${id}-hint`} style={{ marginBottom: 6 }}>
          {hint}
        </p>
      )}
      <div className="chips">
        {WEEKDAYS.map((d) => {
          const on = value.includes(d.value);
          return (
            <button
              key={d.value}
              type="button"
              className="chip"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((v) => v !== d.value) : [...value, d.value].sort((a, b) => a - b))}
            >
              {d.short}
              {/* O nome acessível começa pelo texto visível (WCAG 2.5.3) e completa o dia por extenso. */}
              <span className="visually-hidden"> ({d.long})</span>
            </button>
          );
        })}
      </div>
      {error && (
        <p className="field-error" id={`${id}-error`} style={{ marginTop: 6 }}>
          <CircleAlert size={14} aria-hidden="true" style={{ marginTop: 2 }} />
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Escala de 1 a 5 com rótulos nas pontas (check-in de bem-estar; não é avaliação clínica). */
export function ScalePicker({ label, value, onChange, low, high }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; low: string; high: string }) {
  const id = useId();
  return (
    <div className="field">
      <span className="field-label" id={`${id}-label`}>
        {label} <span className="field-optional">(opcional)</span>
      </span>
      <div className="scale" role="radiogroup" aria-labelledby={`${id}-label`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} de 5${n === 1 ? ` — ${low}` : n === 5 ? ` — ${high}` : ''}`}
            onClick={() => onChange(value === n ? undefined : n)}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="scale-ends" aria-hidden="true">
        <span>1 = {low}</span>
        <span>5 = {high}</span>
      </div>
    </div>
  );
}

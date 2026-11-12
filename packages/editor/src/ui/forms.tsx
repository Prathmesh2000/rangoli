import { cloneElement, forwardRef, useId, useRef } from 'react';
import { GlyphChevron } from './glyphs';
import { cx, moveIndex } from './logic';

interface FieldControlProps {
  id?: string;
  required?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
}

export interface FieldProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** Shown next to the cause, and marks the control invalid. */
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  /** A single Input, Textarea or Select. It receives the id and described-by wiring. */
  children: React.ReactElement<FieldControlProps>;
}

export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const controlId = children.props.id ?? `${id}-control`;
  const describedBy = [children.props['aria-describedby'], hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('rg-field', className)}>
      <label className="rg-field-label" htmlFor={controlId}>{label}{required && ' (required)'}</label>
      {cloneElement(children, { id: controlId, 'aria-describedby': describedBy, 'aria-invalid': error ? true : children.props['aria-invalid'], required: required ?? children.props.required })}
      {hint && <p id={`${id}-hint`} className="rg-field-hint">{hint}</p>}
      {error && <p id={`${id}-error`} className="rg-field-error">{error}</p>}
    </div>
  );
}

/* Text controls stop key events so typing never triggers canvas shortcuts. */

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** For hashes, tokens and values. */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ mono, className, onKeyDown, ...rest }, ref) {
  return <input {...rest} ref={ref} className={cx('rg-input', mono && 'rg-mono', className)} onKeyDown={(e) => { onKeyDown?.(e); e.stopPropagation(); }} />;
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ mono, className, onKeyDown, rows = 3, ...rest }, ref) {
  return <textarea {...rest} ref={ref} rows={rows} className={cx('rg-input', 'rg-textarea', mono && 'rg-mono', className)} onKeyDown={(e) => { onKeyDown?.(e); e.stopPropagation(); }} />;
});

export interface SelectOption { value: string; label: string; disabled?: boolean }

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[];
  /** Shown while the value matches no option. */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ options, placeholder, className, value, defaultValue, ...rest }, ref) {
  const known = value === undefined || options.some((o) => o.value === value);
  return (
    <span className={cx('rg-select', className)}>
      <select {...rest} ref={ref} className="rg-input rg-select-control" value={value === undefined ? undefined : known ? value : ''} defaultValue={value === undefined ? defaultValue ?? (placeholder ? '' : undefined) : undefined}>
        {(placeholder || !known) && <option value="" disabled>{placeholder ?? String(value)}</option>}
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
      <span className="rg-select-chevron" aria-hidden><GlyphChevron /></span>
    </span>
  );
});

export interface SegmentedOption<T extends string> { value: T; label: string; icon?: React.ReactNode; disabled?: boolean }

export interface SegmentedProps<T extends string> {
  /** Accessible name for the group. */
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}

/** Radio group with one tab stop; arrow keys move and select. */
export function Segmented<T extends string>({ label, value, options, onChange, size = 'md', className }: SegmentedProps<T>) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.value === value);
  const tabStop = selected >= 0 ? selected : options.findIndex((o) => !o.disabled);
  return (
    <div role="radiogroup" aria-label={label} className={cx('rg-seg', `rg-seg-${size}`, className)}>
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { items.current[i] = el; }} type="button" role="radio" aria-checked={o.value === value} tabIndex={i === tabStop ? 0 : -1} disabled={o.disabled} className="rg-seg-item"
          onClick={() => o.value !== value && onChange(o.value)}
          onKeyDown={(e) => {
            const next = moveIndex(e.key, i, options.length, { isDisabled: (n) => !!options[n]?.disabled });
            const target = next === null ? undefined : options[next];
            if (next === null || !target) return;
            e.preventDefault();
            e.stopPropagation();
            items.current[next]?.focus();
            if (target.value !== value) onChange(target.value);
          }}>
          {o.icon && <span className="rg-btn-icon" aria-hidden>{o.icon}</span>}
          {o.label}
        </button>
      ))}
    </div>
  );
}

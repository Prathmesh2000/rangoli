import { forwardRef } from 'react';
import { cx } from './logic';

/** `seal` is only for signing: marigold means a person signed. */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'seal';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  iconEnd?: React.ReactNode;
  /** Blocks clicks but keeps keyboard focus, unlike `disabled`. */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, iconEnd, busy, className, children, onClick, type = 'button', ...rest }, ref) {
  return (
    <button {...rest} ref={ref} type={type} className={cx('rg-btn', `rg-btn-${variant}`, `rg-btn-${size}`, className)} aria-busy={busy || undefined} aria-disabled={busy || rest['aria-disabled']}
      onClick={busy ? (e) => e.preventDefault() : onClick}>
      {icon && <span className="rg-btn-icon" aria-hidden>{icon}</span>}
      {children}
      {iconEnd && <span className="rg-btn-icon" aria-hidden>{iconEnd}</span>}
    </button>
  );
});

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Accessible name. Required: the button has no visible text. */
  label: string;
  icon: React.ReactNode;
  /** Makes it a toggle. Pressed shows the selection colour. */
  pressed?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, icon, pressed, size = 'md', className, type = 'button', ...rest }, ref) {
  return (
    <button {...rest} ref={ref} type={type} aria-label={label} aria-pressed={pressed} className={cx('rg-iconbtn', `rg-iconbtn-${size}`, className)}>
      <span className="rg-btn-icon" aria-hidden>{icon}</span>
    </button>
  );
});

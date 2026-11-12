import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';
import { focusables, themeHost } from './dom';
import { GlyphClose } from './glyphs';
import { cx, toastDismissMs } from './logic';

export interface FloatingPanelProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title?: React.ReactNode;
  /** Quiet text beside the title, such as "4 open". */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  elevation?: 1 | 2;
  /** Removes body padding, for content that runs edge to edge. */
  flush?: boolean;
}

/** Tools float above the canvas; the work does not. */
export function FloatingPanel({ title, meta, actions, elevation = 1, flush, className, children, ...rest }: FloatingPanelProps) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} {...rest} className={cx('rg-panel', `rg-e${elevation}`, className)}>
      {(title || actions) && (
        <header className="rg-panel-head">
          {title && <h2 id={id} className="rg-panel-title">{title}</h2>}
          {meta && <span className="rg-panel-meta">{meta}</span>}
          {actions && <div className="rg-panel-actions">{actions}</div>}
        </header>
      )}
      <div className={cx('rg-panel-body', flush && 'is-flush')}>{children}</div>
    </section>
  );
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Pinned to the foot of the sheet, such as the seal and signing action. */
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/** Modal sheet from the right. Traps focus, closes on Escape, and returns focus when it closes. */
export function Sheet({ open, onClose, title, description, footer, children, className }: SheetProps) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => { if (open) setHost(themeHost(anchor.current)); }, [open]);

  useEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const previous = document.activeElement as HTMLElement | null;
    (focusables(el)[0] ?? el).focus();
    return () => previous?.focus?.();
  }, [open, host]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    const el = panel.current;
    if (e.key !== 'Tab' || !el) return;
    const list = focusables(el);
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) { e.preventDefault(); return; }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <>
      <span ref={anchor} hidden />
      {open && host && createPortal(
        <div className="rg-sheet-layer">
          <div className="rg-sheet-scrim" onClick={onClose} />
          <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-desc` : undefined} tabIndex={-1} className={cx('rg-sheet', className)} onKeyDown={onKeyDown}>
            <header className="rg-sheet-head">
              <div>
                <h2 id={`${id}-title`} className="rg-sheet-title">{title}</h2>
                {description && <p id={`${id}-desc`} className="rg-sheet-desc">{description}</p>}
              </div>
              <IconButton label="Close" icon={<GlyphClose />} onClick={onClose} />
            </header>
            <div className="rg-sheet-body">{children}</div>
            {footer && <footer className="rg-sheet-foot">{footer}</footer>}
          </div>
        </div>,
        host,
      )}
    </>
  );
}

export interface ToastProps {
  tone?: 'neutral' | 'fail';
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss: () => void;
  /** Null keeps it until dismissed. Defaults by tone: failures and actions stay. */
  autoDismissMs?: number | null;
  className?: string;
}

/** Render inside ToastRegion, which announces it. A failure announces itself as an alert. */
export function Toast({ tone = 'neutral', children, action, onDismiss, autoDismissMs, className }: ToastProps) {
  const [paused, setPaused] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const ms = autoDismissMs === undefined ? toastDismissMs(tone, !!action) : autoDismissMs;

  useEffect(() => {
    if (ms === null || paused) return;
    const timer = setTimeout(() => dismiss.current(), ms);
    return () => clearTimeout(timer);
  }, [ms, paused]);

  return (
    <div role={tone === 'fail' ? 'alert' : undefined} className={cx('rg-toast', `rg-toast-${tone}`, className)}
      onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="rg-toast-text">{children}</div>
      {action && <button type="button" className="rg-toast-action" onClick={action.onClick}>{action.label}</button>}
      <IconButton size="sm" label="Dismiss" icon={<GlyphClose />} onClick={onDismiss} />
    </div>
  );
}

/** Keep this mounted even when empty: a live region must exist before its content arrives. */
export function ToastRegion({ children, className, label = 'Notifications' }: { children?: React.ReactNode; className?: string; label?: string }) {
  return <div role="region" aria-label={label} aria-live="polite" aria-relevant="additions" className={cx('rg-toasts', className)}>{children}</div>;
}

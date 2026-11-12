import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { themeHost } from './dom';
import { place } from './logic';

interface TooltipTargetProps {
  onPointerEnter?: React.PointerEventHandler<HTMLElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLElement>;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
  'aria-describedby'?: string;
  'aria-label'?: string;
}

export interface TooltipProps {
  content: string;
  /** One focusable element. It must pass pointer, focus and aria props to the DOM. */
  children: React.ReactElement<TooltipTargetProps>;
  align?: 'start' | 'center' | 'end';
}

const OPEN_DELAY = 300;
const CLOSE_DELAY = 120;

/** Shows on hover and keyboard focus. Escape dismisses it, and the pointer can move onto it. */
export function Tooltip({ content, children, align = 'center' }: TooltipProps) {
  const id = useId();
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [target, setTarget] = useState<HTMLElement | null>(null);

  const clear = () => clearTimeout(timer.current);
  const show = (el: HTMLElement, delay: number) => { clear(); timer.current = setTimeout(() => setTarget(el), delay); };
  const hide = () => { clear(); timer.current = setTimeout(() => setTarget(null), CLOSE_DELAY); };

  useEffect(() => clear, []);

  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !target) return;
    const pos = place(target.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { align, prefer: 'above', gap: 8 });
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  }, [target, content, align]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { clear(); setTarget(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [target]);

  const p = children.props;
  const describes = target && p['aria-label'] !== content; // no need to announce the name twice
  return (
    <>
      {cloneElement(children, {
        'aria-describedby': [p['aria-describedby'], describes ? id : ''].filter(Boolean).join(' ') || undefined,
        onPointerEnter: (e: React.PointerEvent<HTMLElement>) => { p.onPointerEnter?.(e); if (e.pointerType !== 'touch') show(e.currentTarget, OPEN_DELAY); },
        onPointerLeave: (e: React.PointerEvent<HTMLElement>) => { p.onPointerLeave?.(e); hide(); },
        onFocus: (e: React.FocusEvent<HTMLElement>) => { p.onFocus?.(e); if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget, 0); },
        onBlur: (e: React.FocusEvent<HTMLElement>) => { p.onBlur?.(e); hide(); },
      })}
      {target && createPortal(<div ref={tip} id={id} role="tooltip" className="rg-tooltip" onPointerEnter={clear} onPointerLeave={hide}>{content}</div>, themeHost(target))}
    </>
  );
}

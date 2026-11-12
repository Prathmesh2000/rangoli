import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { themeHost } from './dom';
import { moveIndex, place, typeaheadIndex } from './logic';

export interface MenuItemDef {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuTriggerProps {
  ref: React.RefObject<HTMLButtonElement>;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>;
}

export interface MenuProps {
  /** Accessible name for the menu. */
  label: string;
  /** Spread the props onto a Button or IconButton. */
  trigger: (props: MenuTriggerProps) => React.ReactNode;
  items: MenuItemDef[];
  align?: 'start' | 'center' | 'end';
}

/** Arrows, Home, End and type-ahead move; Enter or Space selects; Escape or Tab closes and returns focus. */
export function Menu({ label, trigger, items, align = 'start' }: MenuProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const isDisabled = (i: number) => !!items[i]?.disabled;

  const openAt = (key: 'Home' | 'End') => {
    const start = moveIndex(key, 0, items.length, { isDisabled });
    if (start === null) return;
    setActive(start);
    setOpen(true);
  };
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const el = popup.current;
    const anchor = triggerRef.current;
    if (!open || !el || !anchor) return;
    // offsetWidth and offsetHeight ignore the entrance transform.
    const pos = place(anchor.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { align });
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    itemRefs.current[active]?.focus({ preventScroll: true });
  }, [open, active, align]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target;
      // A resize targets the window, which is not a Node.
      if (t instanceof Node && (popup.current?.contains(t) || (e.type === 'pointerdown' && triggerRef.current?.contains(t)))) return;
      // A click elsewhere puts focus there. A scroll or resize would otherwise drop it to the page.
      close(e.type !== 'pointerdown');
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', outside);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', outside);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); return; }
    const next = moveIndex(e.key, active, items.length, { orientation: 'vertical', isDisabled });
    if (next !== null) { e.preventDefault(); setActive(next); return; }
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const hit = typeaheadIndex(e.key, items.map((m) => m.label), active, isDisabled);
      if (hit !== null) setActive(hit);
    }
  };

  return (
    <>
      {trigger({
        ref: triggerRef,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        onClick: () => { if (open) close(); else openAt('Home'); },
        onKeyDown: (e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          e.stopPropagation();
          openAt(e.key === 'ArrowDown' ? 'Home' : 'End');
        },
      })}
      {open && createPortal(
        <div ref={popup} id={id} role="menu" aria-label={label} className="rg-menu" onKeyDown={onMenuKey}>
          {items.map((m, i) => (
            <button key={m.id} ref={(el) => { itemRefs.current[i] = el; }} type="button" role="menuitem" tabIndex={-1} disabled={m.disabled} className="rg-menu-item" onClick={() => { close(); m.onSelect(); }}>
              {m.icon && <span className="rg-btn-icon" aria-hidden>{m.icon}</span>}
              {m.label}
            </button>
          ))}
        </div>,
        themeHost(triggerRef.current),
      )}
    </>
  );
}

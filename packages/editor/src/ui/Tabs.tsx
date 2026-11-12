import { useId, useRef } from 'react';
import { cx, moveIndex } from './logic';

export interface TabDef<T extends string> { id: T; label: string; count?: number; disabled?: boolean }

export interface TabsProps<T extends string> {
  /** Accessible name for the tab list. */
  label: string;
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  /** The active tab's panel. */
  children?: React.ReactNode;
  className?: string;
}

export function Tabs<T extends string>({ label, tabs, value, onChange, children, className }: TabsProps<T>) {
  const id = useId();
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const panelId = `${id}-panel`;
  const tabId = (t: T) => `${id}-tab-${t}`;
  return (
    <div className={cx('rg-tabs', className)}>
      <div role="tablist" aria-label={label} className="rg-tablist">
        {tabs.map((t, i) => (
          <button key={t.id} ref={(el) => { items.current[i] = el; }} id={tabId(t.id)} type="button" role="tab" aria-selected={t.id === value} aria-controls={children !== undefined && t.id === value ? panelId : undefined}
            tabIndex={t.id === value ? 0 : -1} disabled={t.disabled} className="rg-tab" onClick={() => t.id !== value && onChange(t.id)}
            onKeyDown={(e) => {
              const next = moveIndex(e.key, i, tabs.length, { orientation: 'horizontal', isDisabled: (n) => !!tabs[n]?.disabled });
              const target = next === null ? undefined : tabs[next];
              if (next === null || !target) return;
              e.preventDefault();
              e.stopPropagation();
              items.current[next]?.focus();
              if (target.id !== value) onChange(target.id);
            }}>
            {t.label}
            {t.count !== undefined && <span className="rg-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      {children !== undefined && <div id={panelId} role="tabpanel" aria-labelledby={tabId(value)} className="rg-tabpanel">{children}</div>}
    </div>
  );
}

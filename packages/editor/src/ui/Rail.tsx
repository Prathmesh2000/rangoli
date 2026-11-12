import { createContext, useContext } from 'react';
import { cx } from './logic';

const RailExpanded = createContext(false);

export interface RailProps {
  /** Accessible name for the navigation. */
  label: string;
  /** 84px icon over label when false, 232px with labels beside icons when true. */
  expanded?: boolean;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** RailItem and RailGroup. */
  children: React.ReactNode;
  className?: string;
}

export function Rail({ label, expanded = false, header, footer, children, className }: RailProps) {
  return (
    <RailExpanded.Provider value={expanded}>
      <nav aria-label={label} className={cx('rg-rail', expanded && 'is-expanded', className)}>
        {header && <div className="rg-rail-head">{header}</div>}
        <ul className="rg-rail-list">{children}</ul>
        {footer && <div className="rg-rail-foot">{footer}</div>}
      </nav>
    </RailExpanded.Provider>
  );
}

/** A labelled group. The label shows when expanded, and becomes a divider when collapsed. */
export function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const expanded = useContext(RailExpanded);
  return (
    <li className="rg-rail-group">
      <span className={expanded ? 'rg-rail-group-label' : 'rg-visually-hidden'}>{label}</span>
      <ul className="rg-rail-list">{children}</ul>
    </li>
  );
}

export interface RailItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  /** Marks a stage a person has signed, for example "Approved v12". Also read by screen readers. */
  signedLabel?: string;
  href?: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
}

/** Has no disabled state on purpose: stages are views, and they never lock. */
export function RailItem({ icon, label, active, signedLabel, href, onClick }: RailItemProps) {
  const inner = (
    <>
      <span className="rg-rail-icon" aria-hidden>{icon}</span>
      <span className="rg-rail-label">{label}</span>
      {signedLabel && <span className="rg-rail-signed"><span className="rg-visually-hidden">{signedLabel}</span></span>}
    </>
  );
  const common = { className: 'rg-rail-item', 'aria-current': active ? ('page' as const) : undefined, onClick };
  return <li>{href ? <a {...common} href={href}>{inner}</a> : <button {...common} type="button">{inner}</button>}</li>;
}

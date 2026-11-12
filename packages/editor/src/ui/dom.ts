/** Portals go to the nearest themed subtree, so popovers match the surface they opened from. */
export const themeHost = (el: Element | null): HTMLElement => (el?.closest('[data-theme]') as HTMLElement | null | undefined) ?? document.body;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden);

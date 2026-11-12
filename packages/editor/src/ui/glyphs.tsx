/** The kit's own fixed marks (close, chevrons, task states). Anything else takes an icon as a prop. */
function Glyph({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const GlyphClose = () => <Glyph><path d="m4 4 8 8M12 4l-8 8" /></Glyph>;
export const GlyphChevron = () => <Glyph><path d="m4 6 4 4 4-4" /></Glyph>;
export const GlyphPin = () => <Glyph><path d="M13 6.7c0 3.2-3.6 6.2-4.6 7a.6.6 0 0 1-.8 0c-1-.8-4.6-3.8-4.6-7a5 5 0 0 1 10 0Z" /><circle cx="8" cy="6.7" r="1.7" /></Glyph>;
export const GlyphNote = () => <Glyph><path d="M9.5 2H4.5A1 1 0 0 0 3.5 3v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5L9.5 2Z" /><path d="M9.5 2v3.5H13M6 8.5h4M6 11h4" /></Glyph>;
export const GlyphTask = () => <Glyph><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="m5.5 8 1.8 1.8 3.2-3.4" /></Glyph>;
/** Waiting: a still dotted ring. It carries no timer. */
export const GlyphWaiting = () => <Glyph><circle cx="8" cy="8" r="5.75" strokeDasharray="0.1 3" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /></Glyph>;
export const GlyphPickedUp = () => <Glyph><path d="M3.5 3v4.5a2 2 0 0 0 2 2H12" /><path d="m9.5 7 2.5 2.5L9.5 12" /></Glyph>;
/** A run in progress: a still dashed ring. It never spins, because Rangoli can't know work is happening. */
export const GlyphRun = () => <Glyph><circle cx="8" cy="8" r="5.75" strokeDasharray="2.4 2.6" /></Glyph>;
export const GlyphDone = () => <Glyph><circle cx="8" cy="8" r="5.75" /><path d="m5.5 8.2 1.8 1.8 3.2-3.5" /></Glyph>;

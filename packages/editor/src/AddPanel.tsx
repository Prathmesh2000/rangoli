import { useEffect, useMemo, useRef, useState } from 'react';
import { LIBRARY, PATTERNS, SCENE_KIT, applyRdl, createDocument, renderCss, renderFragment } from '@rangoli/engine';
import { indent } from './helpers';
import { startInsertDrag } from './dnd';
import { api, canEdit, getState, rdl, select, useEditor } from './store';

interface Item { key: string; label: string; group: string; hint: string; rdl: string; thumb?: string }

const BASICS: Item[] = [
  { key: 'frame', label: 'Frame', group: 'Basics', hint: 'Container with auto layout', rdl: 'Frame col gap3 p4 w320 h200 fill:surface stroke:border r3' },
  { key: 'row', label: 'Row', group: 'Basics', hint: 'Items side by side', rdl: 'Row row gap3 center p3 wfill h72 stroke:border/1/dashed' },
  { key: 'col', label: 'Column', group: 'Basics', hint: 'Items stacked', rdl: 'Column col gap3 p3 w240 h160 stroke:border/1/dashed' },
  { key: 'grid', label: 'Grid', group: 'Basics', hint: 'Three equal columns', rdl: 'Grid grid cols3 gap3 wfill h120 p3 stroke:border/1/dashed' },
  { key: 'free', label: 'Free frame', group: 'Basics', hint: 'Place things anywhere inside', rdl: 'Canvas none w480 h320 fill:surface stroke:border' },
  { key: 'heading', label: 'Heading', group: 'Text', hint: 'Section title', rdl: 'Title text headline "Heading"' },
  { key: 'title', label: 'Title', group: 'Text', hint: 'Card or panel title', rdl: 'Title text title-sm "Title"' },
  { key: 'text', label: 'Paragraph', group: 'Text', hint: 'Body text', rdl: 'Text body "Write something clear and useful here."' },
  { key: 'caption', label: 'Caption', group: 'Text', hint: 'Small supporting text', rdl: 'Text caption muted "Caption"' },
  { key: 'rect', label: 'Rectangle', group: 'Shapes', hint: 'Solid shape', rdl: 'Rectangle w160 h120 fill:subtle' },
  { key: 'circle', label: 'Circle', group: 'Shapes', hint: 'Solid circle', rdl: 'Circle w120 h120 rfull fill:subtle' },
  { key: 'divider', label: 'Divider', group: 'Shapes', hint: 'Horizontal rule', rdl: 'Line wfill h1 fill:border' },
  { key: 'gradient', label: 'Gradient', group: 'Shapes', hint: 'Colour blend', rdl: 'Gradient w240 h160 r3 fill:linear(135,primary.400,primary.800)' },
  { key: 'icon', label: 'Icon', group: 'Media', hint: 'Change it in the panel', rdl: 'Icon icon:star w24 h24' },
  { key: 'image', label: 'Image', group: 'Media', hint: 'Placeholder until you set one', rdl: 'Image w320 h180 alt:"Describe the image"' },
  { key: 'in-float', label: 'Floating label', group: 'Inputs', hint: 'Label moves up on focus', rdl: '@Input appearance=floating "Email address"' },
  { key: 'in-filled-float', label: 'Filled floating', group: 'Inputs', hint: 'Material-style filled field', rdl: '@Input appearance=floating-filled "Full name"' },
  { key: 'in-filled', label: 'Filled field', group: 'Inputs', hint: 'Soft filled background', rdl: '@Input appearance=filled "Search"' },
  { key: 'in-under', label: 'Underlined field', group: 'Inputs', hint: 'Line only', rdl: '@Input appearance=underlined "Your name"' },
  { key: 'in-pill', label: 'Pill field', group: 'Inputs', hint: 'Fully rounded', rdl: '@Input appearance=pill icon=search "Search"' },
  { key: 'in-help', label: 'With label and help', group: 'Inputs', hint: 'Label above, helper below, counter', rdl: '@Input title="Username" help="Letters and numbers only" max=20 value="asha" "Username"' },
  { key: 'in-error', label: 'Error state', group: 'Inputs', hint: 'Invalid with message', rdl: '@Input state=error title="Email" help="Enter a valid email" value="asha@" "Email"' },
  { key: 'in-affix', label: 'Prefix and suffix', group: 'Inputs', hint: 'Text before and after', rdl: '@Input prefix="https://" suffix=".com" "yourname"' },
  { key: 'in-pass', label: 'Password', group: 'Inputs', hint: 'With show button', rdl: '@Input type=password reveal=true title="Password" value="secret" "Password"' },
  { key: 'bt-outline', label: 'Outline button', group: 'Actions', hint: 'Accent border', rdl: '@Button variant=outline "Learn more"' },
  { key: 'bt-soft', label: 'Soft button', group: 'Actions', hint: 'Tinted', rdl: '@Button variant=soft "Add filter"' },
  { key: 'bt-link', label: 'Link button', group: 'Actions', hint: 'Text only', rdl: '@Button variant=link iconright=arrow-right "View all"' },
  { key: 'bt-icon', label: 'Button with icon', group: 'Actions', hint: 'Leading icon', rdl: '@Button icon=plus "New run"' },
  { key: 'bt-pill', label: 'Pill button', group: 'Actions', hint: 'Fully rounded', rdl: '@Button rfull "Get started"' },
  { key: 'photo-bg', label: 'Image background', group: 'Media', hint: 'Frame ready for a background image', rdl: 'Banner col middle gap2 p8 wfill h240 r3 fill:subtle\n  Title text headline "Add a background in Fill"' },
];

const ORDER = ['Basics', 'Text', 'Shapes', 'Media', 'Actions', 'Inputs', 'Display', 'Navigation', 'Feedback', 'Charts', 'Data', 'Web3', '3D', 'Layout', 'Forms', 'Overlays', 'Auth', 'Marketing', 'Commerce', 'Collaboration', 'Developer', 'Testing', 'My components'];

/** Layout primitives have no content to preview, so they get a drawing of how they arrange things. */
const SCHEMATIC: Record<string, React.ReactNode> = {
  frame: <rect x="10" y="8" width="44" height="32" rx="3" />,
  row: <><rect x="6" y="14" width="15" height="20" rx="2" /><rect x="25" y="14" width="15" height="20" rx="2" /><rect x="44" y="14" width="15" height="20" rx="2" /></>,
  col: <><rect x="16" y="5" width="32" height="10" rx="2" /><rect x="16" y="19" width="32" height="10" rx="2" /><rect x="16" y="33" width="32" height="10" rx="2" /></>,
  grid: <><rect x="10" y="6" width="13" height="16" rx="2" /><rect x="26" y="6" width="13" height="16" rx="2" /><rect x="42" y="6" width="13" height="16" rx="2" /><rect x="10" y="26" width="13" height="16" rx="2" /><rect x="26" y="26" width="13" height="16" rx="2" /><rect x="42" y="26" width="13" height="16" rx="2" /></>,
  free: <><rect x="8" y="6" width="48" height="36" rx="3" strokeDasharray="3 3" /><rect x="14" y="12" width="14" height="10" rx="2" /><rect x="34" y="24" width="16" height="12" rx="2" /></>,
  divider: <line x1="8" y1="24" x2="56" y2="24" />,
  'photo-bg': <><rect x="8" y="6" width="48" height="36" rx="3" /><circle cx="20" cy="16" r="4" /><path d="M8 36l14-12 10 8 8-6 16 12" /></>,
  image: <><rect x="8" y="6" width="48" height="36" rx="3" /><circle cx="20" cy="16" r="4" /><path d="M8 36l14-12 10 8 8-6 16 12" /></>,
};

/** Live miniature of an item, rendered lazily by the real engine in the document's current look. */
function Thumb({ line }: { line: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const version = useEditor((s) => s.doc?.data.tokens);
  const mode = useEditor((s) => s.mode);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting) || cancelled) return;
      io.disconnect();
      const live = getState().doc;
      if (!live) return;
      try {
        const doc = createDocument('thumb');
        doc.data.tokens = live.data.tokens;
        doc.data.components = live.data.components;
        doc.data.icons = live.data.icons;
        doc.data.assets = live.data.assets;
        applyRdl(doc, line);
        const frag = renderFragment(doc, { assetBase: api('/assets/') });
        const css = renderCss(doc, frag.css, frag.usedComponents).replace(/:root\b/g, ':host').replace(/\[data-mode="([^"]+)"\]/g, ':host([data-mode="$1"])').replace(/(^|\n)body\{/g, '$1:host{');
        const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${css}:host{background:transparent!important;overflow:hidden;text-align:left}.t{position:absolute;left:0;top:0;display:flex;flex-direction:column;width:max-content;max-width:900px;transform-origin:0 0;pointer-events:none}*{animation:none!important}</style><div class="t">${frag.html}</div>`;
        if (mode !== 'light') host.setAttribute('data-mode', mode); else host.removeAttribute('data-mode');
        const t = root.querySelector<HTMLElement>('.t')!;
        requestAnimationFrame(() => {
          // items that fill their parent collapse in an empty tile: give them a page-like width
          if ((t.firstElementChild as HTMLElement | null)?.offsetWidth! < 30 || t.offsetWidth < 30) t.style.width = '320px';
          const W = host.clientWidth, H = host.clientHeight;
          const s = Math.min(1, (W - 12) / (t.offsetWidth || 1), (H - 12) / (t.offsetHeight || 1));
          t.style.transform = `translate(${(W - t.offsetWidth * s) / 2}px, ${(H - t.offsetHeight * s) / 2}px) scale(${s})`;
        });
      } catch { /* an item that cannot render keeps its empty tile */ }
    }, { rootMargin: '120px' });
    io.observe(host);
    return () => { cancelled = true; io.disconnect(); };
  }, [line, version, mode]);
  return <div ref={ref} className="add-thumb-host" />;
}

async function insertAtSelection(line: string, label: string) {
  const s = getState();
  const target = s.selection.length === 1 ? s.doc?.findNode(s.selection[0]!)?.node : undefined;
  const script = !target ? line : target.type === 'frame' || target.type === 'group' ? `insert #${target.id} end\n${indent(line)}` : `insert #${target.id} after\n${indent(line)}`;
  const res = await rdl(script, `add ${label}`);
  if (res?.created[0]) select([res.created[0]]);
}

export function AddPanel() {
  const components = useEditor((s) => s.doc?.data.components);
  const [query, setQuery] = useState('');
  const [listView, setListView] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set(['Basics', 'Text', 'Shapes', 'Media', 'Actions', 'Inputs', '3D']));
  const inputRef = useRef<HTMLInputElement>(null);
  const focusTick = useEditor((s) => s.addFocus);
  useEffect(() => { if (focusTick) inputRef.current?.focus(); }, [focusTick]);

  const items = useMemo<Item[]>(() => {
    const own = Object.values(components ?? {}).filter((c) => c.template).map((c) => ({ key: `u-${c.id}`, label: c.id, group: 'My components', hint: c.description ?? 'Your building block', rdl: `@${c.id}` }));
    return [
      ...BASICS,
      ...own,
      ...SCENE_KIT.map((k) => ({ key: `k-${k.name}`, label: k.name, group: '3D', hint: 'Starter 3D design. Fully editable in the 3D Studio.', rdl: `@Scene3D h360 light=${k.light ?? 'studio'} particles=${k.particles ?? 0} cam=${k.cam ?? 6} objects=${JSON.stringify(k.objects)} "${k.name}"` })),
      ...Object.entries(LIBRARY).map(([name, d]) => ({ key: `c-${name}`, label: name.replace(/([a-z])([A-Z0-9])/g, '$1 $2'), group: d.doc.category, hint: d.doc.description, rdl: d.doc.example })),
      ...Object.entries(PATTERNS).map(([name, p]) => ({ key: `p-${name}`, label: name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), group: p.category, hint: p.description, rdl: `+${name}` })),
    ];
  }, [components]);

  const q = query.trim().toLowerCase();
  const list = q ? items.filter((e) => `${e.label} ${e.group} ${e.hint}`.toLowerCase().includes(q)) : items;
  const groups = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const e of list) m.set(e.group, [...(m.get(e.group) ?? []), e]);
    return [...m].sort(([a], [b]) => ORDER.indexOf(a) - ORDER.indexOf(b));
  }, [list]);
  const toggle = (g: string) => setOpen((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const editable = canEdit();

  return (
    <div className="add" onKeyDown={(e) => e.stopPropagation()}>
      <div className="add-search">
        <input ref={inputRef} className="input" placeholder={`Search ${items.length} items`} aria-label="Search components and patterns" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); if (e.key === 'Enter' && list[0]) void insertAtSelection(list[0].rdl, list[0].label); }} />
        <button className="tog" aria-pressed={listView} title="Show as a list" onClick={() => setListView(!listView)}>List</button>
      </div>
      <div className="add-list">
        {!list.length && <p className="hint add-empty">Nothing matches “{query}”.</p>}
        {groups.map(([g, entries]) => {
          const isOpen = !!q || open.has(g);
          return (
            <section key={g}>
              <button className="add-group" aria-expanded={isOpen} onClick={() => toggle(g)}>
                <span aria-hidden>{isOpen ? '▾' : '▸'}</span>{g}<span className="add-count">{entries.length}</span>
              </button>
              {isOpen && (
                <div className={listView ? 'add-rows' : 'add-grid'}>
                  {entries.map((e) => (
                    <button key={e.key} className="add-tile" title={`${e.hint}\nClick to add, or drag onto the canvas`} disabled={!editable} data-add={e.key}
                      onPointerDown={(ev) => { if (ev.button === 0 && editable) startInsertDrag(ev, e.label, e.rdl); }}
                      onClick={() => void insertAtSelection(e.rdl, e.label)}>
                      {!listView && <span className="add-thumb">{SCHEMATIC[e.key]
                        ? <svg className="add-schematic" viewBox="0 0 64 48" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">{SCHEMATIC[e.key]}</svg>
                        : e.group === '3D' ? <span className="add-3d">3D</span> : <Thumb line={e.rdl} />}</span>}
                      <span className="add-label">{e.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

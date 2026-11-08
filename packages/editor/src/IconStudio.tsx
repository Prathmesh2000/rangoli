import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { applyRdl, cloneDocument, compileIcon, iconReact, iconSprite, iconSvg, lintIcons, type Diagnostic, type IconDef, type IconSet } from '@rangoli/engine';
import { renderInto } from './Canvas';
import { indent } from './helpers';
import { canEdit, getState, rdl, setState, toast, useEditor } from './store';

const download = (name: string, content: string, type = 'image/svg+xml') => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
};

export function IconStudio() {
  const version = useEditor((s) => s.version);
  const sel = useEditor((s) => s.iconSel);
  const doc = getState().doc;
  const sets = doc?.data.icons ?? {};
  const [setName, iconName] = (sel ?? '').split('/') as [string, string];
  const set = sets[setName ?? ''];
  const icon = set?.icons[iconName ?? ''];

  // auto-select only when nothing is selected — a just-created icon may not have synced yet
  useEffect(() => {
    if (!sel) {
      const first = Object.values(sets).find((s) => s.name !== 'drafts' && Object.keys(s.icons).length);
      const name = first && Object.keys(first.icons)[0];
      if (first && name) setState({ iconSel: `${first.name}/${name}` });
    }
  }, [version, sel, sets]);

  if (!doc) return null;
  return (
    <div className="studio">
      <aside className="studio-left">
        <IconSets sets={sets} sel={sel} />
      </aside>
      <main className="studio-center">{set && icon ? <IconPreview set={set} icon={icon} /> : <div className="panel-empty">Select an icon</div>}</main>
      <aside className="studio-right">{set && icon ? <IconSource set={set} icon={icon} /> : null}</aside>
    </div>
  );
}

function IconSets({ sets, sel }: { sets: Record<string, IconSet>; sel: string | null }) {
  const drafts = sets.drafts;
  const main = Object.values(sets).filter((s) => s.name !== 'drafts');
  const target = main[0]?.name ?? 'ui';
  const groups = useMemo(() => {
    const g = new Map<string, IconDef[]>();
    for (const ic of Object.values(drafts?.icons ?? {})) {
      const base = ic.name.split('~')[0]!;
      g.set(base, [...(g.get(base) ?? []), ic]);
    }
    return [...g];
  }, [drafts]);

  const keep = (base: string, ic: IconDef) => {
    const discard = (drafts ? Object.keys(drafts.icons) : []).filter((n) => n.split('~')[0] === base).map((n) => `icon drafts/${n} none`);
    void rdl([`icon ${target}/${base}${ic.stroke ? ` stroke${ic.stroke}` : ''}`, indent(ic.src), ...discard].join('\n'), `keep ${ic.name} as ${target}/${base}`).then((r) => r && setState({ iconSel: `${target}/${base}` }));
  };

  return (
    <>
      {groups.length > 0 && drafts && (
        <section className="section">
          <h3 className="section-title">Drafts — pick one</h3>
          {groups.map(([base, list]) => (
            <div key={base} className="draft-group">
              <div className="draft-name">{base}</div>
              <div className="icon-grid">
                {list.map((ic) => (
                  <div key={ic.name} className={`draft${sel === `drafts/${ic.name}` ? ' is-sel' : ''}`}>
                    <button className="icon-tile" title={ic.name} onClick={() => setState({ iconSel: `drafts/${ic.name}` })} dangerouslySetInnerHTML={{ __html: iconSvg(drafts, ic, { size: 24 }) }} />
                    {canEdit() && <button className="btn btn-sm-inline" onClick={() => keep(base, ic)}>Keep</button>}
                  </div>
                ))}
              </div>
              {canEdit() && <button className="btn btn-sm-inline" onClick={() => void rdl(list.map((ic) => `icon drafts/${ic.name} none`).join('\n'), `discard ${base} drafts`)}>Discard all</button>}
            </div>
          ))}
        </section>
      )}
      {main.map((s) => (
        <section key={s.name} className="section">
          <h3 className="section-title">{s.name} · {Object.keys(s.icons).length} · grid {s.grid} · stroke {s.stroke}</h3>
          <div className="icon-grid">
            {Object.values(s.icons).map((ic) => (
              <button key={ic.name} className={`icon-tile${sel === `${s.name}/${ic.name}` ? ' is-sel' : ''}`} title={ic.name} aria-label={ic.name}
                onClick={() => setState({ iconSel: `${s.name}/${ic.name}` })} dangerouslySetInnerHTML={{ __html: iconSvg(s, ic, { size: 24 }) }} />
            ))}
            {canEdit() && (
              <button className="icon-tile icon-new" title="New icon" aria-label="New icon"
                onClick={() => {
                  let n = 1;
                  while (s.icons[`new-${n}`]) n++;
                  void rdl(`icon ${s.name}/new-${n}\n  circle 12 12 8.5`, 'new icon').then((r) => r && setState({ iconSel: `${s.name}/new-${n}` }));
                }}>+</button>
            )}
          </div>
          <div className="code-actions" style={{ marginTop: 8 }}>
            <button className="btn btn-sm-inline" onClick={() => download(`${s.name}-sprite.svg`, iconSprite(s))}>Download sprite</button>
          </div>
        </section>
      ))}
    </>
  );
}

/** Big grid editor preview + sizes + in-context rendering (live while typing). */
function IconPreview({ set, icon }: { set: IconSet; icon: IconDef }) {
  const draft = useEditor((s) => s.iconDraft);
  const src = draft ?? icon.src;
  const compiled = useMemo(() => compileIcon(src, []), [src]);
  const g = set.grid;
  const S = 384, u = S / g;
  const sw = icon.stroke ?? set.stroke;
  const previewIcon: IconDef = { ...icon, src };
  const ctxRef = useRef<HTMLDivElement>(null);

  // in-context examples rendered by the real engine (button, chip, row) in a throwaway copy
  useLayoutEffect(() => {
    const host = ctxRef.current;
    const doc = getState().doc;
    if (!host || !doc) return;
    const copy = cloneDocument(doc);
    const ref = `${set.name}/${icon.name}`;
    copy.data.icons![set.name]!.icons[icon.name] = previewIcon;
    try {
      const r = applyRdl(copy, `Ctx row gap4 p4 center fill:surface r3\n  @Button variant=secondary size=sm "Run again"\n    Icon icon:${ref} w16 h16\n  @Button variant=primary size=sm "Start"\n    Icon icon:${ref} w16 h16\n  @Chip variant=info "Queued"\n    Icon icon:${ref} w12 h12\n  Line row gap2 center\n    Icon icon:${ref} w16 h16 color:text.secondary\n    Text body-sm "Checkout flow"`);
      const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      const only = cloneDocument(copy);
      only.page().children = [r.created[0]!];
      renderInto(root, only, '.stage{padding:0;gap:0}');
    } catch {
      /* invalid draft — preview keeps last good state */
    }
  });

  return (
    <div className="icon-preview">
      <svg className="icon-board" width={S} height={S} viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`${icon.name} on a ${g}px grid`}>
        {Array.from({ length: g + 1 }, (_, i) => (
          <g key={i} className={i % 4 === 0 ? 'grid-major' : 'grid-minor'}>
            <line x1={i * u} y1={0} x2={i * u} y2={S} />
            <line x1={0} y1={i * u} x2={S} y2={i * u} />
          </g>
        ))}
        <g className="keyline">
          <circle cx={S / 2} cy={S / 2} r={(g / 2 - 2) * u} />
          <rect x={3 * u} y={3 * u} width={(g - 6) * u} height={(g - 6) * u} rx={2 * u} />
          <rect x={4 * u} y={2 * u} width={(g - 8) * u} height={(g - 4) * u} rx={2 * u} />
          <rect x={2 * u} y={4 * u} width={(g - 4) * u} height={(g - 8) * u} rx={2 * u} />
        </g>
        <rect className="live-area" x={(g / 16) * u} y={(g / 16) * u} width={(g - g / 8) * u} height={(g - g / 8) * u} />
        <g transform={`scale(${u})`} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap={set.cap} strokeLinejoin={set.join} className="icon-strokes">
          {compiled.shapes.map((s, i) => (s.fill ? <path key={i} d={s.d} fill="currentColor" stroke="none" /> : <path key={i} d={s.d} />))}
        </g>
        <g className="vertices">
          {compiled.shapes.flatMap((s) => s.points).map(([x, y], i) => <circle key={i} cx={x * u} cy={y * u} r={3} />)}
        </g>
      </svg>
      <div className="icon-sizes">
        {[16, 20, 24, 32].map((s) => <span key={s} className="icon-size" title={`${s}px`} dangerouslySetInnerHTML={{ __html: iconSvg(set, previewIcon, { size: s }) }} />)}
        <span className="icon-sizes-sep" />
        {[16, 20, 24, 32].map((s) => <span key={s} className="icon-size is-dark" title={`${s}px dark`} dangerouslySetInnerHTML={{ __html: iconSvg(set, previewIcon, { size: s }) }} />)}
      </div>
      <div className="icon-ctx" ref={ctxRef} />
      <p className="hint">Grid {g}px · keylines (circle, square, portrait, landscape) · dashed = live area · {compiled.shapes.length} shapes{compiled.snapped ? ` · ${compiled.snapped} points snapped to 0.5` : ''}</p>
    </div>
  );
}

function IconSource({ set, icon }: { set: IconSet; icon: IconDef }) {
  const version = useEditor((s) => s.version);
  const [draft, setDraft] = useState(icon.src);
  const ref = `${set.name}/${icon.name}`;
  useEffect(() => {
    setDraft(icon.src);
    setState({ iconDraft: null });
  }, [ref, icon.src, version]);
  const diag: Diagnostic[] = [];
  compileIcon(draft, diag);
  const issues = lintIcons({ [set.name]: { ...set, icons: { ...set.icons, [icon.name]: { ...icon, src: draft } } } }, [ref]);
  const dirty = draft !== icon.src;
  const [name, setName] = useState(icon.name);
  useEffect(() => setName(icon.name), [icon.name]);
  const apply = () => void rdl(`icon ${ref}${icon.stroke ? ` stroke${icon.stroke}` : ''}\n${indent(draft)}`, `edit icon ${ref}`);
  const editable = canEdit();

  return (
    <div className="props">
      <div className="inspector-head">
        <div className="inspector-title">{icon.name}</div>
        <div className="inspector-sub">{set.name} · grid {set.grid} · stroke {icon.stroke ?? set.stroke} · {set.cap}</div>
      </div>
      <section className="section">
        <h3 className="section-title">Shapes</h3>
        <textarea className="code code-sm" rows={9} spellCheck={false} value={draft} readOnly={!editable}
          onChange={(e) => {
            setDraft(e.target.value);
            setState({ iconDraft: e.target.value });
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && dirty && !diag.length) apply();
            e.stopPropagation();
          }} />
        {diag.length > 0 && <p className="cs-conflict">{diag.map((d) => `line ${d.line}: ${d.message}`).join('\n')}</p>}
        {editable && (
          <div className="code-actions">
            <span className="hint" style={{ flex: 1 }}>line · polyline · polygon · rect · circle · dot · arc · path</span>
            <button className="btn" disabled={!dirty} onClick={() => { setDraft(icon.src); setState({ iconDraft: null }); }}>Reset</button>
            <button className="btn btn-primary" disabled={!dirty || diag.length > 0} onClick={apply}>Apply</button>
          </div>
        )}
      </section>
      <section className="section">
        <h3 className="section-title">Checks</h3>
        {!issues.length && <p className="hint">Consistent with the set.</p>}
        {issues.map((i, k) => (
          <div key={k} className="lint-row"><span className={`sev sev-${i.severity}`}>{i.severity}</span><span>{i.message}</span></div>
        ))}
      </section>
      {editable && set.name !== 'drafts' && (
        <section className="section">
          <h3 className="section-title">Rename / delete</h3>
          <div className="brand-row">
            <input className="input" value={name} onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, '-'))} onKeyDown={(e) => e.stopPropagation()} aria-label="Icon name" />
            <button className="btn" disabled={!name || name === icon.name || !!set.icons[name]}
              onClick={() => void rdl(`icon ${set.name}/${name}${icon.stroke ? ` stroke${icon.stroke}` : ''}\n${indent(icon.src)}\nicon ${ref} none`, `rename ${ref} → ${name}`).then((r) => r && setState({ iconSel: `${set.name}/${name}` }))}>Rename</button>
          </div>
          <button className="btn btn-sm" onClick={() => void rdl(`icon ${ref} none`, `delete icon ${ref}`).then((r) => r && setState({ iconSel: null }))}>Delete icon</button>
        </section>
      )}
      <section className="section">
        <h3 className="section-title">Export</h3>
        <div className="chips">
          <button className="chip-btn" onClick={() => download(`${icon.name}.svg`, iconSvg(set, icon) + '\n')}>SVG</button>
          <button className="chip-btn" onClick={() => void navigator.clipboard?.writeText(iconReact(set, icon)).then(() => toast('info', 'React component copied'))}>Copy React</button>
          <button className="chip-btn" onClick={() => void navigator.clipboard?.writeText(`Icon icon:${icon.name} w16 h16`).then(() => toast('info', 'RDL copied'))}>Copy RDL use</button>
        </div>
      </section>
    </div>
  );
}

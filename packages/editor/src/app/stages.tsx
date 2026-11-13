import { useState, type FormEvent, type ReactNode } from 'react';
import { COMPONENT_STATES, CYCLE_SCOPED, deviceName, framesOfScreen, MAX_FRAME_SIZE, MIN_TEST_SESSIONS, REQUIRED_STATES, itemCapability, SCREEN_DEVICES, suggestTemplate, WF_TEMPLATE_IDS, WF_TEMPLATES, type ItemKind, type LifecycleItem, type ScreenDevicePreset } from '@rangoli/engine';
import { del, ErrorLine, Field as FieldFrame, Link, Modal, patch, post, useAction } from './core';
import type { JourneyData, StageView } from './Journey';

export interface WorkProps {
  j: JourneyData;
  stage: StageView;
  reload: () => Promise<void>;
  name: (id: string | null) => string;
}

/** Every stage view is open: work can be added anywhere, at any time, by anyone allowed to write it. */
const framesOf = (j: JourneyData, s: LifecycleItem) => framesOfScreen(s, j.screenFrames);
/** The screen's first frame that is on the canvas, primary first. */
const canvasFrame = (j: JourneyData, s: LifecycleItem) => framesOf(j, s).map((id) => j.frames.find((f) => f.id === id)).find((f) => !!f);

// ---------------------------------------------------------------- schema-driven forms

type FieldDef = {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
} & (
  | { type: 'text' | 'area' }
  | { type: 'select'; options: { value: string; label: string }[] }
  | { type: 'ref'; kind: ItemKind }
  | { type: 'refs'; kind: ItemKind; ordered?: boolean }
);

/** title and body are columns; everything else lives in data */
const readField = (item: Partial<LifecycleItem> | undefined, key: string): unknown => (key === 'title' || key === 'body' ? item?.[key] : item?.data?.[key]);

function ItemForm({ j, kind, fields, item, onDone, onCancel, submit, titleFrom }: { j: JourneyData; kind: ItemKind; fields: FieldDef[]; item?: LifecycleItem; onDone: () => Promise<void>; onCancel?: () => void; submit: string; titleFrom?: string }) {
  const [v, setV] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.key, readField(item, f.key) ?? (f.type === 'refs' ? [] : f.type === 'select' ? f.options[0]?.value : '')])));
  const { busy, error, run } = useAction();
  const set = (k: string, val: unknown) => setV((x) => ({ ...x, [k]: val }));
  const options = (k: ItemKind) => j.items.filter((i) => i.kind === k && (!CYCLE_SCOPED.includes(k) || i.cycle === j.project.cycle || k === 'research'));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => {
      const data: Record<string, unknown> = {};
      for (const f of fields) if (f.key !== 'title' && f.key !== 'body') data[f.key] = v[f.key] === '' && f.type === 'ref' ? null : v[f.key];
      const title = titleFrom ? String(v[titleFrom] ?? '') : (v.title as string | undefined);
      const payload = { ...(title !== undefined ? { title } : {}), ...(v.body !== undefined ? { body: v.body } : {}), data };
      if (item) await patch(`/api/projects/${j.project.id}/items/${item.id}`, payload);
      else await post(`/api/projects/${j.project.id}/items`, { kind, ...payload });
      await onDone();
    });
    if (ok && !item) setV(Object.fromEntries(fields.map((f) => [f.key, f.type === 'refs' ? [] : f.type === 'select' ? f.options[0]?.value : ''])));
  };

  return (
    <form className="a-form" onSubmit={(e) => void save(e)}>
      {fields.map((f) => (
        <FieldFrame key={f.key} label={f.label} hint={f.hint}>
          {f.type === 'text' && <input className="a-input" required={f.required} placeholder={f.placeholder} value={String(v[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />}
          {f.type === 'area' && <textarea className="a-input" rows={3} required={f.required} placeholder={f.placeholder} value={String(v[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />}
          {f.type === 'select' && <select className="a-input" value={String(v[f.key])} onChange={(e) => set(f.key, e.target.value)}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
          {f.type === 'ref' && (
            <select className="a-input" required={f.required} value={String(v[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">Choose…</option>
              {options(f.kind).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
            </select>
          )}
          {f.type === 'refs' && <RefPicker items={options(f.kind)} value={v[f.key] as string[]} ordered={f.ordered} onChange={(x) => set(f.key, x)} />}
        </FieldFrame>
      ))}
      <ErrorLine error={error} />
      <div className="a-inline">
        <button className="a-btn a-btn-primary" disabled={busy}>{submit}</button>
        {onCancel && <button type="button" className="a-btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function RefPicker({ items, value, ordered, onChange }: { items: LifecycleItem[]; value: string[]; ordered?: boolean; onChange: (v: string[]) => void }) {
  if (!items.length) return <span className="a-muted">Nothing to link yet.</span>;
  return (
    <div className="picker">
      {items.map((o) => {
        const at = value.indexOf(o.id);
        return (
          <button key={o.id} type="button" className="picker-chip" aria-pressed={at >= 0} onClick={() => onChange(at >= 0 ? value.filter((x) => x !== o.id) : [...value, o.id])}>
            {ordered && at >= 0 && <span className="picker-n">{at + 1}</span>}
            {o.title}
          </button>
        );
      })}
    </div>
  );
}

/** One record that is simply filled in, like the brief. */
function Singleton({ j, kind, fields, reload, title }: { j: JourneyData; kind: ItemKind; fields: FieldDef[]; reload: () => Promise<void>; title: string }) {
  const item = j.items.find((i) => i.kind === kind);
  const readOnly = !j.can.includes(itemCapability(kind));
  return (
    <section className="work-section">
      <h2 className="a-h2">{title}</h2>
      {readOnly
        ? <dl className="read-list">{fields.map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{String(readField(item, f.key) ?? '') || <span className="a-muted">Not written yet</span>}</dd></div>)}</dl>
        : <ItemForm key={item?.updated_at ?? 'new'} j={j} kind={kind} fields={fields} item={item} onDone={reload} submit="Save" />}
    </section>
  );
}

function Items({ j, reload, kind, fields, title, hint, noun, meta, titleFrom, extra, renderForm }: {
  j: JourneyData;
  reload: () => Promise<void>;
  kind: ItemKind;
  fields: FieldDef[];
  title: string;
  hint?: string;
  noun: string;
  meta?: (i: LifecycleItem) => ReactNode;
  titleFrom?: string;
  extra?: (i: LifecycleItem) => ReactNode;
  renderForm?: (i: LifecycleItem | undefined, close: () => Promise<void>, cancel: () => void) => ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const { error, run } = useAction();
  const list = j.items.filter((i) => i.kind === kind && (!CYCLE_SCOPED.includes(kind) || i.cycle === j.project.cycle));
  // the same rule as the database: the plan needs design.edit; evidence needs evidence.add, and then only your own
  const writer = j.can.includes('design.edit');
  const canAdd = writer || j.can.includes(itemCapability(kind));
  const canChange = (i: LifecycleItem) => writer || (j.can.includes(itemCapability(kind)) && i.created_by === j.me);
  const done = async () => { setAdding(false); setEditing(null); await reload(); };
  return (
    <section className="work-section">
      <div className="work-head">
        <div>
          <h2 className="a-h2">{title}</h2>
          {hint && <p className="a-muted">{hint}</p>}
        </div>
        {canAdd && !adding && <button className="a-btn" onClick={() => setAdding(true)}>Add {noun}</button>}
      </div>
      {adding && <div className="work-card">{renderForm ? renderForm(undefined, done, () => setAdding(false)) : <ItemForm j={j} kind={kind} fields={fields} onDone={done} onCancel={() => setAdding(false)} submit={`Add ${noun}`} titleFrom={titleFrom} />}</div>}
      {list.length === 0 && !adding && <p className="work-empty">No {noun}s yet.</p>}
      <ErrorLine error={error} />
      <ul className="work-list">
        {list.map((i) => editing === i.id
          ? <li key={i.id} className="work-card">{renderForm ? renderForm(i, done, () => setEditing(null)) : <ItemForm j={j} kind={kind} fields={fields} item={i} onDone={done} onCancel={() => setEditing(null)} submit="Save" titleFrom={titleFrom} />}</li>
          : (
            <li key={i.id} className="work-item">
              <div className="work-main">
                <span className="a-row-title">{i.title || 'Untitled'}</span>
                {i.body && <p className="work-body">{i.body}</p>}
                {meta && <div className="work-meta">{meta(i)}</div>}
                {extra?.(i)}
              </div>
              {canChange(i) && (
                <div className="work-actions">
                  <button className="a-link" onClick={() => setEditing(i.id)}>Edit</button>
                  <button className="a-link a-danger" onClick={() => void run(async () => { await del(`/api/projects/${j.project.id}/items/${i.id}`); await reload(); })}>Delete</button>
                </div>
              )}
            </li>
          ))}
      </ul>
    </section>
  );
}

const titleOf = (j: JourneyData, id: unknown) => j.items.find((i) => i.id === id)?.title ?? '';
const Tag = ({ children, tone }: { children: ReactNode; tone?: string }) => <span className={`tag${tone ? ` tag-${tone}` : ''}`}>{children}</span>;

// ---------------------------------------------------------------- the nine stages

const METHODS = [['interview', 'User interview'], ['competitor', 'Competitor analysis'], ['analytics', 'Analytics review'], ['stakeholder', 'Stakeholder talk'], ['feedback', 'Launch feedback'], ['other', 'Other']].map(([value, label]) => ({ value: value!, label: label! }));

function Discovery({ j, reload }: WorkProps) {
  return (
    <>
      <Singleton j={j} reload={reload} kind="brief" title="Brief" fields={[
        { key: 'users', label: 'Who are the users, and what are they trying to do?', type: 'area' },
        { key: 'body', label: 'What problem does the product solve?', type: 'area' },
        { key: 'goals', label: 'Business goals', type: 'area' },
        { key: 'constraints', label: 'Constraints', type: 'area', hint: 'Budget, deadlines, platforms, legal' },
      ]} />
      <Items j={j} reload={reload} kind="research" title="Research" noun="note" hint="Interviews, competitors, analytics and stakeholder conversations from this cycle."
        meta={(i) => <><Tag>{METHODS.find((m) => m.value === i.data.method)?.label}</Tag>{i.data.source && <span className="a-muted">{i.data.source}</span>}</>}
        extra={(i) => i.data.insight ? <p className="work-insight">{i.data.insight}</p> : <p className="work-missing">Add what you learned from this</p>}
        fields={[
          { key: 'title', label: 'Title', type: 'text', required: true, placeholder: 'Interview with a warehouse lead' },
          { key: 'method', label: 'Method', type: 'select', options: METHODS },
          { key: 'source', label: 'Source', type: 'text', placeholder: 'Who or where' },
          { key: 'body', label: 'Notes', type: 'area' },
          { key: 'insight', label: 'What we learned', type: 'area', hint: 'The one thing this changes about the design', required: true },
        ]} />
    </>
  );
}

function Define({ j, reload }: WorkProps) {
  return (
    <>
      <Singleton j={j} reload={reload} kind="problem" title="Problem statement" fields={[{ key: 'body', label: 'Who needs what, and why', type: 'area', required: true, placeholder: 'A QA engineer needs to launch a test run and see its status without leaving the page.' }]} />
      <Items j={j} reload={reload} kind="persona" title="Personas" noun="persona"
        meta={(i) => <>{i.data.role && <Tag>{i.data.role}</Tag>}{(i.data.evidence?.length ?? 0) > 0 ? <span className="a-muted">Based on {i.data.evidence.map((e: string) => titleOf(j, e)).join(', ')}</span> : <span className="work-missing">Link the research behind this</span>}</>}
        fields={[
          { key: 'title', label: 'Name', type: 'text', required: true },
          { key: 'role', label: 'Role', type: 'text', placeholder: 'QA engineer' },
          { key: 'body', label: 'Summary', type: 'area' },
          { key: 'goals', label: 'Goals', type: 'area' },
          { key: 'frustrations', label: 'Frustrations', type: 'area' },
          { key: 'evidence', label: 'Based on which research?', type: 'refs', kind: 'research' },
        ]} />
      <Items j={j} reload={reload} kind="story" title="User stories" noun="story" titleFrom="want"
        meta={(i) => <span className="a-muted">As {titleOf(j, i.data.persona) || 'someone'}, so that {i.data.soThat || '…'}</span>}
        fields={[
          { key: 'persona', label: 'As…', type: 'ref', kind: 'persona', required: true },
          { key: 'want', label: 'I want to…', type: 'text', required: true, placeholder: 'launch a test run' },
          { key: 'soThat', label: 'So that…', type: 'text', placeholder: 'I can see its status without leaving the page' },
        ]} />
    </>
  );
}

function Ia({ j, reload }: WorkProps) {
  return (
    <>
      <Items j={j} reload={reload} kind="screen" title="Screens" noun="screen" hint="Every screen the product needs, and which stories it serves."
        meta={(i) => (i.data.stories?.length ?? 0) > 0 ? <span className="a-muted">Serves: {i.data.stories.map((s: string) => titleOf(j, s)).join(', ')}</span> : null}
        fields={[
          { key: 'title', label: 'Screen name', type: 'text', required: true, placeholder: 'Test cases' },
          { key: 'body', label: 'What is it for?', type: 'area' },
          { key: 'stories', label: 'Serves which stories?', type: 'refs', kind: 'story' },
        ]} />
      <Items j={j} reload={reload} kind="flow" title="User flows" noun="flow" hint="How someone moves between screens to get something done."
        extra={(i) => <FlowPath steps={((i.data.steps as string[] | undefined) ?? []).map((s) => titleOf(j, s))} />}
        fields={[
          { key: 'title', label: 'Flow name', type: 'text', required: true, placeholder: 'Launch a test run' },
          { key: 'story', label: 'For which story?', type: 'ref', kind: 'story' },
          { key: 'steps', label: 'Steps, in order', type: 'refs', kind: 'screen', ordered: true, hint: 'Click screens in the order someone visits them' },
        ]} />
    </>
  );
}

const FlowPath = ({ steps }: { steps: string[] }) => (steps.length ? <p className="flow-path">{steps.map((s, i) => <span key={i}>{i > 0 && <span aria-hidden> → </span>}{s}</span>)}</p> : null);

/** Duplicate to device: a linked copy of the screen's frame at another size. */
function AddDevice({ j, screen, reload }: { j: JourneyData; screen: LifecycleItem; reload: () => Promise<void> }) {
  const taken = new Set(j.screenFrames.filter((f) => f.screen === screen.id && j.frames.some((x) => x.id === f.frame)).map((f) => f.device));
  const free = (Object.keys(SCREEN_DEVICES) as ScreenDevicePreset[]).filter((d) => !taken.has(d));
  const [device, setDevice] = useState<string>(free[0] ?? 'custom');
  const [w, setW] = useState('1280');
  const [h, setH] = useState('800');
  const { busy, error, run } = useAction();
  const add = () => run(async () => {
    await post(`/api/projects/${j.project.id}/screens/${screen.id}/frames`, device === 'custom' ? { device, w: Number(w), h: Number(h) } : { device });
    await reload();
  });
  return (
    <div className="a-inline">
      <select className="a-input" aria-label={`Device for a copy of ${screen.title}`} value={device} onChange={(e) => setDevice(e.target.value)}>
        {free.map((d) => <option key={d} value={d}>{SCREEN_DEVICES[d].name} ({SCREEN_DEVICES[d].w} × {SCREEN_DEVICES[d].h})</option>)}
        <option value="custom">Custom size</option>
      </select>
      {device === 'custom' && <>
        <input className="a-input" type="number" min={1} max={MAX_FRAME_SIZE} aria-label="Width" value={w} onChange={(e) => setW(e.target.value)} style={{ width: 88 }} />
        <input className="a-input" type="number" min={1} max={MAX_FRAME_SIZE} aria-label="Height" value={h} onChange={(e) => setH(e.target.value)} style={{ width: 88 }} />
      </>}
      <button className="a-btn" disabled={busy} onClick={() => void add()}>Duplicate to device</button>
      <ErrorLine error={error} />
    </div>
  );
}

function ScreenFrames({ j, note, reload }: { j: JourneyData; note: string; reload: () => Promise<void> }) {
  const screens = j.items.filter((i) => i.kind === 'screen');
  const writer = j.can.includes('design.edit');
  return (
    <section className="work-section">
      <h2 className="a-h2">Screens</h2>
      <p className="a-muted">{note} A screen can have a frame per device, linked together.</p>
      <ul className="work-list">
        {screens.map((s) => {
          const ids = framesOf(j, s);
          const onCanvas = canvasFrame(j, s);
          return (
            <li key={s.id} className="work-item">
              <div className="work-main">
                <span className="a-row-title">{s.title}</span>
                {s.body && <p className="work-body">{s.body}</p>}
                {ids.length > 0 && (
                  <div className="work-meta">
                    {ids.map((id) => {
                      const link = j.screenFrames.find((f) => f.frame === id);
                      const frame = j.frames.find((f) => f.id === id);
                      const label = `${deviceName(link?.device ?? 'desktop')} ${frame ? `${frame.w}×${frame.h}` : ''}`.trim();
                      return <Tag key={id} tone={frame ? undefined : 'warn'}>{label}{id === s.data.frame ? ' · primary' : ''}{frame ? '' : ' · not on canvas'}</Tag>;
                    })}
                  </div>
                )}
                {writer && onCanvas && <AddDevice j={j} screen={s} reload={reload} />}
              </div>
              {onCanvas ? <Tag tone="ok">On canvas · {onCanvas.nodes} layers</Tag> : <Tag tone="warn">No frame yet</Tag>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The flows agreed in IA, drawn with the real screens. Arrows go solid once the link exists. */
function Wireflow({ j, showLinks }: { j: JourneyData; showLinks: boolean }) {
  const flows = j.items.filter((i) => i.kind === 'flow');
  const screen = (id: string) => j.items.find((i) => i.id === id);
  const THUMB = 200;
  if (!flows.length) return null;
  return (
    <section className="work-section">
      <h2 className="a-h2">Wireflow</h2>
      <p className="a-muted">Each flow from IA, with the screens as they stand now.</p>
      <div className="wireflow">
        {flows.map((f) => {
          const steps = ((f.data.steps as string[] | undefined) ?? []).map(screen).filter((x): x is LifecycleItem => !!x);
          return (
            <div key={f.id} className="wf-flow">
              <span className="a-row-title">{f.title}</span>
              <div className="wf-steps">
                {steps.map((s, i) => {
                  const frame = canvasFrame(j, s);
                  const prev = steps[i - 1] ? framesOf(j, steps[i - 1]!) : [];
                  const mine = framesOf(j, s);
                  const linked = j.links.some(([a, b]) => prev.includes(a) && mine.includes(b));
                  const scale = frame ? Math.min(THUMB / frame.w, 1) : 1;
                  return (
                    <div key={s.id + i} style={{ display: 'contents' }}>
                      {i > 0 && <span className={`wf-arrow ${linked ? 'is-linked' : 'is-open'}`} aria-label={showLinks ? (linked ? 'Linked' : 'Not linked yet') : 'Then'}>{showLinks && linked ? '━▶' : '┄▶'}</span>}
                      <div className="wf-step">
                        {frame
                          ? <div className="wf-thumb" style={{ width: frame.w * scale, height: frame.h * scale }}><iframe title={s.title} loading="lazy" sandbox="allow-scripts" src={`/d/${j.project.id}/?root=${frame.id}&skin=clean`} style={{ width: frame.w, height: frame.h, transform: `scale(${scale})` }} /></div>
                          : <div className="wf-thumb wf-thumb-empty">No frame yet</div>}
                        <span className="a-small">{s.title}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CreateWireframes({ j, reload }: { j: JourneyData; reload: () => Promise<void> }) {
  const missing = j.items.filter((i) => i.kind === 'screen' && !canvasFrame(j, i));
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState<ScreenDevicePreset>('desktop');
  const [templates, setTemplates] = useState<Record<string, string>>(() => Object.fromEntries(missing.map((s) => [s.id, suggestTemplate(s.title, s.body)])));
  const { busy, error, run } = useAction();
  if (!missing.length) return null;
  const chosen = (id: string, s: LifecycleItem) => templates[id] ?? suggestTemplate(s.title, s.body);
  const label = (id: string) => (id === 'blank' ? 'Blank' : WF_TEMPLATES[id]!.name);
  return (
    <>
      <button className="a-btn a-btn-primary" onClick={() => setOpen(true)}>Create {missing.length} wireframe{missing.length === 1 ? '' : 's'}</button>
      {open && (
        <Modal title="Create wireframes" onClose={() => setOpen(false)}>
          <FieldFrame label="Device" hint="Add frames for other devices later with Duplicate to device."><select className="a-input" value={device} onChange={(e) => setDevice(e.target.value as ScreenDevicePreset)}>{Object.entries(SCREEN_DEVICES).map(([id, d]) => <option key={id} value={id}>{d.name} ({d.w} × {d.h})</option>)}</select></FieldFrame>
          <p className="a-label">Starting layout</p>
          {missing.map((s) => (
            <div key={s.id} className="wf-create">
              <span className="a-truncate">{s.title}</span>
              <select className="a-input" aria-label={`Layout for ${s.title}`} value={chosen(s.id, s)} onChange={(e) => setTemplates({ ...templates, [s.id]: e.target.value })}>{WF_TEMPLATE_IDS.map((id) => <option key={id} value={id}>{label(id)}</option>)}</select>
            </div>
          ))}
          <p className={j.agent.online ? 'a-muted' : 'form-error'}>{j.agent.online ? 'Your agent is connected and can draft these from the problem, personas and stories.' : 'No agent is connected. Requests wait until one is.'}</p>
          <ErrorLine error={error} />
          <div className="a-actions">
            <button className="a-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="a-btn" disabled={busy} onClick={() => void run(async () => {
              await post(`/api/projects/${j.project.id}/agent-wireframes`, { device: device === 'ipad' ? 'tablet' : device });
              await reload();
            }).then((ok) => ok && setOpen(false))}>Ask agent to draft</button>
            <button className="a-btn a-btn-primary" disabled={busy} onClick={() => void run(async () => {
              await post(`/api/projects/${j.project.id}/wireframes`, { device, templates: Object.fromEntries(missing.map((s) => [s.id, chosen(s.id, s)])) });
              await reload();
            }).then((ok) => ok && setOpen(false))}>Create wireframes</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function AgentQueue({ j }: { j: JourneyData }) {
  const open = j.agent.requests.filter((r) => r.status === 'pending' || r.status === 'working');
  if (!open.length) return null;
  return (
    <section className="work-section">
      <h2 className="a-h2">Waiting on your agent</h2>
      <p className="a-muted">{j.agent.online ? 'Agents act when asked. Tell yours:' : 'No agent is connected yet. Once it is, tell it:'} <code>Use the Rangoli agent_requests tool and work through every request.</code></p>
      <ul className="work-list">
        {open.map((r) => <li key={r.id} className="work-item"><span className="a-row-title">{r.screen?.name ?? (r.prompt.slice(0, 80) || 'From an image')}</span><span className="tag">{r.status === 'working' ? 'In progress' : 'Queued'}</span></li>)}
      </ul>
    </section>
  );
}

function Wireframes({ j, reload }: WorkProps) {
  return (
    <>
      <div className="work-callout">
        <p>Settle structure and content placement here. The canvas opens in Wireframe mode, with no color or real images, so the conversation stays on layout. Add notes to record behaviour.</p>
        <div className="a-inline">
          {j.can.includes('design.edit') && <CreateWireframes key={j.items.length} j={j} reload={reload} />}
          <Link className="a-btn" href={`/p/${j.project.id}/design`}>Open canvas</Link>
          <a className="a-btn" href={`/d/${j.project.id}/spec`} target="_blank" rel="noopener">Print annotated spec</a>
        </div>
      </div>
      <AgentQueue j={j} />
      <Wireflow j={j} showLinks={false} />
      <ScreenFrames j={j} reload={reload} note="Each screen agreed in IA & flows gets a frame." />
    </>
  );
}

function Visual({ j, reload }: WorkProps) {
  return (
    <>
      <div className="work-callout">
        <p>Bring in color, type, spacing and components. A design language applies them consistently across every screen. A named version of the wireframes was saved when this stage began, so reviewers can compare.</p>
        <div className="a-inline"><Link className="a-btn a-btn-primary" href={`/p/${j.project.id}/design`}>Open canvas</Link></div>
      </div>
      <section className="work-section">
        <h2 className="a-h2">Blocking issues</h2>
        {j.blocking.length === 0 ? <p className="work-empty">No P0 or P1 lint issues.</p> : (
          <ul className="work-list">
            {j.blocking.slice(0, 20).map((b, i) => <li key={i} className="work-item"><div className="work-main"><span>{b.message}</span><div className="work-meta"><Tag tone="bad">{b.severity}</Tag><code>{b.code}</code></div></div></li>)}
          </ul>
        )}
      </section>
      <ScreenFrames j={j} reload={reload} note="High-fidelity versions of every screen." />
    </>
  );
}

function Prototype({ j }: WorkProps) {
  const flows = j.items.filter((i) => i.kind === 'flow');
  return (
    <>
      <div className="work-callout">
        <p>Link the screens so people can click through before any code is written. In the canvas, select an element and use the Prototype tab, or have your agent add <code>proto</code> links.</p>
        <div className="a-inline">
          <Link className="a-btn a-btn-primary" href={`/p/${j.project.id}/design`}>Open canvas</Link>
          <a className="a-btn" href={`/d/${j.project.id}/play`} target="_blank" rel="noopener">Play prototype</a>
        </div>
      </div>
      <Wireflow j={j} showLinks />
      <section className="work-section">
        <h2 className="a-h2">Flows to link</h2>
        <ul className="work-list">
          {flows.map((f) => <li key={f.id} className="work-item"><div className="work-main"><span className="a-row-title">{f.title}</span><FlowPath steps={((f.data.steps as string[] | undefined) ?? []).map((s) => titleOf(j, s))} /></div></li>)}
        </ul>
      </section>
    </>
  );
}

function SessionForm({ j, item, onDone, onCancel }: { j: JourneyData; item?: LifecycleItem; onDone: () => Promise<void>; onCancel: () => void }) {
  const tasks = j.items.filter((i) => i.kind === 'test_task');
  const prior = (item?.data.results as { task: string; outcome: string; note?: string }[] | undefined) ?? [];
  const [title, setTitle] = useState(item?.title ?? '');
  const [date, setDate] = useState<string>(item?.data.date ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [results, setResults] = useState(() => tasks.map((t) => ({ task: t.id, outcome: prior.find((p) => p.task === t.id)?.outcome ?? 'pass', note: prior.find((p) => p.task === t.id)?.note ?? '' })));
  const { busy, error, run } = useAction();
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const payload = { title, body, data: { date, results } };
      if (item) await patch(`/api/projects/${j.project.id}/items/${item.id}`, payload);
      else await post(`/api/projects/${j.project.id}/items`, { kind: 'test_session', ...payload });
      await onDone();
    });
  };
  return (
    <form className="a-form" onSubmit={save}>
      <FieldFrame label="Participant"><input className="a-input" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="P1, warehouse lead" /></FieldFrame>
      <FieldFrame label="Date"><input className="a-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FieldFrame>
      {tasks.length === 0 && <p className="work-missing">Write test tasks first, so there is something to record.</p>}
      {results.map((r, n) => (
        <div key={r.task} className="result-row">
          <span className="a-row-title">{titleOf(j, r.task)}</span>
          <select className="a-input" aria-label={`Outcome for ${titleOf(j, r.task)}`} value={r.outcome} onChange={(e) => setResults(results.map((x, i) => (i === n ? { ...x, outcome: e.target.value } : x)))}>
            <option value="pass">Completed</option>
            <option value="struggled">Struggled</option>
            <option value="fail">Could not finish</option>
          </select>
          <input className="a-input" aria-label={`Note for ${titleOf(j, r.task)}`} placeholder="What happened" value={r.note} onChange={(e) => setResults(results.map((x, i) => (i === n ? { ...x, note: e.target.value } : x)))} />
        </div>
      ))}
      <FieldFrame label="Notes"><textarea className="a-input" rows={2} value={body} onChange={(e) => setBody(e.target.value)} /></FieldFrame>
      <ErrorLine error={error} />
      <div className="a-inline">
        <button className="a-btn a-btn-primary" disabled={busy}>Save session</button>
        <button type="button" className="a-btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const SEVERITY = [['P0', 'P0 · Blocks the task'], ['P1', 'P1 · Serious'], ['P2', 'P2 · Annoying'], ['P3', 'P3 · Minor']].map(([value, label]) => ({ value: value!, label: label! }));
const FINDING_STATUS = [['open', 'Not triaged'], ['fix', 'Will fix'], ['fixed', 'Fixed'], ['wontfix', "Won't fix"]] as const;

function Testing({ j, reload }: WorkProps) {
  const { error, run } = useAction();
  const setStatus = (i: LifecycleItem, status: string) => run(async () => { await patch(`/api/projects/${j.project.id}/items/${i.id}`, { status }); await reload(); });
  const outcomes: Record<string, string> = { pass: 'Completed', struggled: 'Struggled', fail: 'Could not finish' };
  const tone: Record<string, string> = { pass: 'ok', struggled: 'warn', fail: 'bad' };
  return (
    <>
      <div className="work-callout">
        <p>Watch real people use the prototype, and aim for at least {MIN_TEST_SESSIONS} sessions. Test a saved version so everyone sees the same thing. If something needs reworking, fix it or send the project back.</p>
        <div className="a-inline"><a className="a-btn a-btn-primary" href={`/d/${j.project.id}/play`} target="_blank" rel="noopener">Play prototype</a></div>
      </div>
      <Items j={j} reload={reload} kind="test_task" title="Test tasks" noun="task" hint="What participants are asked to do, drawn from your user stories."
        meta={(i) => <span className="a-muted">{titleOf(j, i.data.story) && `Story: ${titleOf(j, i.data.story)}. `}{i.data.success && `Success: ${i.data.success}`}</span>}
        fields={[
          { key: 'title', label: 'Task', type: 'text', required: true, placeholder: 'Launch a run for the login suite' },
          { key: 'story', label: 'Tests which story?', type: 'ref', kind: 'story', required: true },
          { key: 'success', label: 'What counts as success?', type: 'text' },
        ]} />
      <Items j={j} reload={reload} kind="test_session" title="Sessions" noun="session" fields={[]}
        renderForm={(i, done, cancel) => <SessionForm j={j} item={i} onDone={done} onCancel={cancel} />}
        extra={(i) => <div className="work-meta">{((i.data.results as { task: string; outcome: string }[] | undefined) ?? []).map((r) => <Tag key={r.task} tone={tone[r.outcome]}>{titleOf(j, r.task)}: {outcomes[r.outcome]}</Tag>)}</div>} />
      <Items j={j} reload={reload} kind="finding" title="Findings" noun="finding" hint="Findings tied to a screen appear as review pins on the canvas."
        meta={(i) => <><Tag tone={['P0', 'P1'].includes(i.data.severity) ? 'bad' : undefined}>{i.data.severity}</Tag>{i.data.screen && <span className="a-muted">{titleOf(j, i.data.screen)}</span>}</>}
        extra={(i) => j.can.includes('design.edit')
          ? <label className="work-status"><span className="a-muted">Decision</span><select className="a-select" value={i.status} onChange={(e) => void setStatus(i, e.target.value)}>{FINDING_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          : <div className="work-meta"><Tag>{FINDING_STATUS.find(([v]) => v === i.status)?.[1]}</Tag></div>}
        fields={[
          { key: 'title', label: 'What went wrong?', type: 'text', required: true },
          { key: 'severity', label: 'Severity', type: 'select', options: SEVERITY },
          { key: 'screen', label: 'On which screen?', type: 'ref', kind: 'screen' },
          { key: 'body', label: 'Details', type: 'area' },
        ]} />
      <ErrorLine error={error} />
    </>
  );
}

function Handoff({ j, reload }: WorkProps) {
  const screens = j.items.filter((i) => i.kind === 'screen');
  const { busy, error, run } = useAction();
  const writer = j.can.includes('design.edit');
  const cycleState = (cur: unknown) => (cur === 'done' ? 'na' : cur === 'na' ? null : 'done');
  const setState = (s: LifecycleItem, st: string) => run(async () => {
    await patch(`/api/projects/${j.project.id}/items/${s.id}`, { data: { states: { ...(s.data.states ?? {}), [st]: cycleState(s.data.states?.[st]) } } });
    await reload();
  });
  const label = (v: unknown) => (v === 'done' ? 'Designed' : v === 'na' ? 'Not applicable' : 'Missing');
  return (
    <>
      <div className="work-callout">
        <p>Developers should be able to build this without guessing. The bundle holds every screen in RDL, tokens, flows, states, assets and your notes. It is the latest approved version; the working copy comes marked Unapproved.</p>
        <div className="a-inline">
          <a className="a-btn a-btn-primary" href={`/api/projects/${j.project.id}/handoff`} download>Download approved bundle</a>
          <a className="a-btn" href={`/api/projects/${j.project.id}/handoff?snapshot=working`} download>Working copy (unapproved)</a>
          <Link className="a-btn" href={`/p/${j.project.id}/review`}>Snapshots and share links</Link>
          <a className="a-btn" href={`/d/${j.project.id}/spec?skin=none`} target="_blank" rel="noopener">Print annotated spec</a>
        </div>
      </div>
      <section className="work-section">
        <h2 className="a-h2">Component states</h2>
        <p className="a-muted">Click to cycle: designed, not applicable, missing. {REQUIRED_STATES.join(', ')} are required on every screen.</p>
        <ErrorLine error={error} />
        <div className="a-scroll">
          <table className="a-table a-matrix">
            <thead><tr><th>Screen</th>{COMPONENT_STATES.map((st) => <th key={st} className="a-cap">{st}{REQUIRED_STATES.includes(st) && <span className="sr-only"> (required)</span>}</th>)}</tr></thead>
            <tbody>
              {screens.map((s) => (
                <tr key={s.id}>
                  <td className="a-cell-main"><span className="a-row-title">{s.title}</span></td>
                  {COMPONENT_STATES.map((st) => {
                    const v = s.data.states?.[st];
                    return (
                      <td key={st}>
                        <button className={`state-cell is-${v ?? 'none'}`} disabled={!writer || busy} aria-label={`${s.title}, ${st}: ${label(v)}`} title={label(v)} onClick={() => void setState(s, st)}>
                          {v === 'done' ? '✓' : v === 'na' ? 'n/a' : '·'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="work-section">
        <h2 className="a-h2">Developer notes</h2>
        {screens.map((s) => <SpecRow key={s.id + (s.updated_at ?? '')} j={j} screen={s} reload={reload} writer={writer} />)}
      </section>
    </>
  );
}

function SpecRow({ j, screen, reload, writer }: { j: JourneyData; screen: LifecycleItem; reload: () => Promise<void>; writer: boolean }) {
  const initial = String(screen.data.spec ?? '');
  const [spec, setSpec] = useState(initial);
  const { busy, error, run } = useAction();
  return (
    <form className="spec-row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await patch(`/api/projects/${j.project.id}/items/${screen.id}`, { data: { spec } }); await reload(); }); }}>
      <FieldFrame label={screen.title}><textarea className="a-input" rows={2} readOnly={!writer} placeholder="Behaviour, edge cases, data rules" value={spec} onChange={(e) => setSpec(e.target.value)} /></FieldFrame>
      {writer && <button className="a-btn" disabled={busy || spec === initial}>Save</button>}
      <ErrorLine error={error} />
    </form>
  );
}

function Launch({ j, reload }: WorkProps) {
  return (
    <>
      <Items j={j} reload={reload} kind="metric" title="Results" noun="metric" hint="Did the design do what it set out to do?"
        meta={(i) => <><span className="a-muted">Target {i.data.target || 'not set'}</span>{i.data.actual ? <Tag tone="ok">Actual {i.data.actual}</Tag> : <span className="work-missing">Not measured yet</span>}</>}
        fields={[
          { key: 'title', label: 'What are you measuring?', type: 'text', required: true, placeholder: 'Task completion' },
          { key: 'target', label: 'Target', type: 'text', placeholder: '90%' },
          { key: 'actual', label: 'Actual', type: 'text', placeholder: '94%' },
        ]} />
      <Items j={j} reload={reload} kind="feedback" title="Feedback" noun="feedback" hint="What people said after launch. You choose what carries into the next cycle."
        meta={(i) => <>{i.data.source && <span className="a-muted">{i.data.source}</span>}{i.status === 'promoted' && <Tag tone="ok">In next cycle</Tag>}</>}
        fields={[
          { key: 'title', label: 'What did you hear?', type: 'text', required: true },
          { key: 'source', label: 'Source', type: 'text', placeholder: 'Support, survey, sales' },
          { key: 'body', label: 'Details', type: 'area' },
        ]} />
    </>
  );
}

export function StageWork(p: WorkProps) {
  switch (p.stage.id) {
    case 'discovery': return <Discovery {...p} />;
    case 'define': return <Define {...p} />;
    case 'ia': return <Ia {...p} />;
    case 'wireframes': return <Wireframes {...p} />;
    case 'visual': return <Visual {...p} />;
    case 'prototype': return <Prototype {...p} />;
    case 'testing': return <Testing {...p} />;
    case 'handoff': return <Handoff {...p} />;
    case 'launch': return <Launch {...p} />;
  }
}

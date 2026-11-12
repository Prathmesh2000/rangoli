import { useEffect, useState } from 'react';
import { serializePrototype, type RNode } from '@rangoli/engine';
import { indent } from './helpers';
import { canEdit, getState, rdl, useEditor, api } from './store';

const TRANSITIONS = ['dissolve', 'smart', 'slide left', 'slide right', 'push left', 'push right', 'slide up', 'instant'];

/** Interactions on the selected layer + start-screen control + quick add. */
export function ProtoTab({ node }: { node: RNode }) {
  const version = useEditor((s) => s.version);
  const doc = getState().doc!;
  const page = doc.page();
  const screens = page.children.filter((id) => page.nodes[id]?.type === 'frame').map((id) => ({ id, name: page.nodes[id]!.name }));
  const isScreen = !node.parent;
  const isStart = doc.data.prototype?.start === node.id;
  const list = doc.data.prototype?.interactions[node.id] ?? [];
  const source = serializePrototype({ interactions: list.length ? { [node.id]: list } : {} }, {}, [node.id]).split('\n').slice(1).map((l) => l.replace(/^ {2}/, '')).join('\n');
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source, version]);
  const incoming = Object.entries(doc.data.prototype?.interactions ?? {}).filter(([, l]) => l.some((i) => i.target === node.id)).length;

  // quick add
  const [trigger, setTrigger] = useState('click');
  const [action, setAction] = useState('navigate');
  const [target, setTarget] = useState(screens.find((s) => s.id !== node.id)?.id ?? '');
  const [transition, setTransition] = useState('dissolve');
  const needsTarget = action === 'navigate' || action === 'overlay';
  const needsLayer = action === 'show' || action === 'hide' || action === 'togglelayer';
  const layers = Object.values(page.nodes).filter((n) => n.parent && n.type === 'frame');
  const [layer, setLayer] = useState(layers[0]?.id ?? '');
  const [variable, setVariable] = useState('');
  const [value, setValue] = useState('');
  const [only, setOnly] = useState('');
  const declared = Object.entries(doc.data.prototype?.variables ?? {}).map(([k, v]) => `${k}=${/\s/.test(v) ? JSON.stringify(v) : v}`).join(' ');
  const [vars, setVars] = useState(declared);
  useEffect(() => setVars(declared), [declared]);
  const isLogic = action === 'set' || action === 'toggle' || needsLayer;
  const comp = node.component ? doc.data.components[node.component] : undefined;
  const swapOptions = comp ? Object.entries(comp.axes).flatMap(([k, vs]) => vs.map((v) => `${k}=${v}`)) : [];
  const [swapTo, setSwapTo] = useState(swapOptions[0] ?? '');
  const timelines = Object.keys(doc.data.timelines ?? {});
  const [tl, setTl] = useState(timelines[0] ?? '');

  const lineFor = () => {
    const parts = [trigger === 'delay' ? 'delay:1500' : trigger, action === 'togglelayer' ? 'toggle' : action];
    if (needsTarget) parts.push(`#${target}`);
    if (needsLayer) parts.push(`#${layer}`);
    if (action === 'set') parts.push(`${variable.trim()}=${/\s/.test(value) ? JSON.stringify(value) : value}`);
    if (action === 'toggle') parts.push(variable.trim());
    if (action === 'swap') parts.push(swapTo);
    if (action === 'play') parts.push(`timeline:${tl}`);
    if (action !== 'play' && action !== 'swap' && !isLogic) parts.push(transition);
    if (only.trim()) parts.push('if', only.trim());
    return parts.join(' ');
  };
  const save = (lines: string) => {
    const body = lines.trim();
    return rdl(body ? `proto #${node.id}\n${indent(body)}` : `proto #${node.id} none`, body ? 'edit interactions' : 'remove interactions');
  };
  const editable = canEdit();

  return (
    <div className="props">
      {isScreen && (
        <section className="section">
          <h3 className="section-title">Screen</h3>
          <div className="code-actions">
            <span className="hint" style={{ flex: 1 }}>{isStart ? 'Prototype starts here.' : incoming ? `${incoming} interaction${incoming > 1 ? 's' : ''} lead here.` : 'Not linked yet.'}</span>
            {editable && !isStart && <button className="btn" onClick={() => void rdl(`proto start #${node.id}`, 'set start screen')}>Set as start</button>}
            <button className="btn btn-primary" onClick={() => window.open(api(`/play?start=${node.id}`), '_blank', 'noopener')}>▶ Play from here</button>
          </div>
        </section>
      )}

      {editable && (
        <section className="section">
          <h3 className="section-title">Add interaction</h3>
          <div className="quick">
            <select className="input select" value={trigger} onChange={(e) => setTrigger(e.target.value)} aria-label="Trigger">
              <option value="click">On click</option>
              <option value="hover">While hovering</option>
              <option value="press">On press</option>
              <option value="delay">After delay</option>
            </select>
            <select className="input select" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
              <option value="navigate">Navigate to</option>
              <option value="overlay">Open overlay</option>
              <option value="close">Close overlay</option>
              <option value="back">Back</option>
              {comp && <option value="swap">Change variant</option>}
              {timelines.length > 0 && <option value="play">Play timeline</option>}
              <option value="set">Set variable</option>
              <option value="toggle">Toggle variable</option>
              <option value="show">Show layer</option>
              <option value="hide">Hide layer</option>
              <option value="togglelayer">Show or hide layer</option>
            </select>
            {needsTarget && (
              <select className="input select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target screen">
                {screens.filter((s) => s.id !== node.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            {action === 'swap' && (
              <select className="input select" value={swapTo} onChange={(e) => setSwapTo(e.target.value)} aria-label="Variant">
                {swapOptions.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            {action === 'play' && (
              <select className="input select" value={tl} onChange={(e) => setTl(e.target.value)} aria-label="Timeline">
                {timelines.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            {needsLayer && (
              <select className="input select" value={layer} onChange={(e) => setLayer(e.target.value)} aria-label="Layer">
                {layers.map((n) => <option key={n.id} value={n.id}>{n.name} #{n.id}</option>)}
              </select>
            )}
            {(action === 'set' || action === 'toggle') && <input className="input" aria-label="Variable name" placeholder="Variable" value={variable} onChange={(e) => setVariable(e.target.value)} />}
            {action === 'set' && <input className="input" aria-label="New value" placeholder="Value, or +1" value={value} onChange={(e) => setValue(e.target.value)} />}
            <input className="input" aria-label="Only if" placeholder="Only if, e.g. plan=pro" value={only} onChange={(e) => setOnly(e.target.value)} />
            {action !== 'play' && action !== 'swap' && !isLogic && (
              <select className="input select" value={transition} onChange={(e) => setTransition(e.target.value)} aria-label="Transition">
                {TRANSITIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            <button className="btn btn-primary" disabled={(needsTarget && !target) || (needsLayer && !layer) || ((action === 'set' || action === 'toggle') && !variable.trim())} onClick={() => void save([source, lineFor()].filter(Boolean).join('\n')).then(() => setOnly(''))}>Add</button>
          </div>
        </section>
      )}

      {editable && (
        <section className="section">
          <h3 className="section-title">Variables</h3>
          <input className="input" aria-label="Starting values" placeholder="plan=free seats=1" value={vars} onChange={(e) => setVars(e.target.value)} />
          <div className="code-actions">
            <span className="hint" style={{ flex: 1 }}>Show a value in any text with {'{{plan}}'}</span>
            <button className="btn btn-primary" disabled={vars.trim() === declared} onClick={() => void rdl(vars.trim() ? `proto var none\nproto var ${vars.trim()}` : 'proto var none', 'prototype variables')}>Apply</button>
          </div>
        </section>
      )}

      <section className="section">
        <h3 className="section-title">Interactions</h3>
        <textarea className="code code-sm" rows={4} spellCheck={false} value={draft} readOnly={!editable} placeholder="click navigate #screen smart" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void save(draft);
            e.stopPropagation();
          }} />
        {editable && (
          <div className="code-actions">
            <span className="hint" style={{ flex: 1 }}>trigger · action · target · transition</span>
            {list.length > 0 && <button className="btn" onClick={() => void save('')}>Remove all</button>}
            <button className="btn btn-primary" disabled={draft === source} onClick={() => void save(draft)}>Apply</button>
          </div>
        )}
      </section>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { besideFrame, deviceName, framesOfScreen, MAX_FRAME_SIZE, SCREEN_DEVICES, type LifecycleItem, type RNode, type ScreenDevicePreset, type ScreenFrameLink } from '@rangoli/engine';
import { activePageId, canEdit, getState, rdl, select, toast, useEditor } from './store';
import { liveCanvas } from './retained';
import { duplicateScript } from './helpers';
import { moveFrames } from './Canvas';

/**
 * A top-level frame's place and size on the page (the keyboard path for moving and resizing frames), and its
 * linked device frames: duplicate to device makes a copy at another size, linked to the same screen.
 */
export function FramePanel({ node }: { node: RNode }) {
  const version = useEditor((s) => s.version);
  const zoom = useEditor((s) => s.zoom);
  const editable = canEdit();
  const c = liveCanvas();
  const b = c?.bounds(node.id);
  const fixed = (k: 'w' | 'h') => (node.size?.[k]?.kind === 'fixed' && typeof node.size[k]!.v === 'number' ? (node.size[k]!.v as number) : undefined);
  const x = Math.round(node.position?.x ?? b?.x ?? 0), y = Math.round(node.position?.y ?? b?.y ?? 0);
  const w = fixed('w') ?? Math.round(b?.w ?? 0), h = fixed('h') ?? Math.round(b?.h ?? 0);
  void version; void zoom;

  const commit = (k: 'x' | 'y' | 'w' | 'h', raw: string) => {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return;
    if (k === 'x' || k === 'y') {
      if (!c) return;
      void moveFrames(c, [node.id], k === 'x' ? v - x : 0, k === 'y' ? v - y : 0);
    } else {
      const n = Math.min(MAX_FRAME_SIZE, Math.max(1, v));
      if (n !== (k === 'w' ? w : h)) void rdl(`set #${node.id} ${k}${n}`, 'resize frame');
    }
  };

  return (
    <div className="section frame-panel">
      <div className="section-title">Frame on the page</div>
      <div className="frame-fields">
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <label key={k} className="frame-field">
            <span>{k.toUpperCase()}</span>
            <NumberField label={{ x: 'X position', y: 'Y position', w: 'Width', h: 'Height' }[k]} value={{ x, y, w, h }[k]} disabled={!editable} onCommit={(v) => commit(k, v)} />
          </label>
        ))}
      </div>
      {!node.position && <p className="hint">Flows in the row with other unplaced frames until moved.</p>}
      <DeviceFrames node={node} editable={editable} />
    </div>
  );
}

function NumberField({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input className="input input-sm" type="number" inputMode="numeric" aria-label={label} value={draft} disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== String(value)) onCommit(draft); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onCommit(draft);
        if (e.key === 'Escape') setDraft(String(value));
      }} />
  );
}

interface Screens { items: LifecycleItem[]; screenFrames: ScreenFrameLink[] }

/** Screens and their device frames from the team app (hosted designs only). */
function useScreens(): { data: Screens | null; reload: () => void } {
  const hosted = useEditor((s) => s.hosted);
  const version = useEditor((s) => s.version);
  const [data, setData] = useState<Screens | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!hosted) { setData(null); return; }
    let live = true;
    void fetch(`/api/projects/${hosted.projectId}/journey`, { cache: 'no-store' }).then(async (r) => {
      if (!r.ok || !live) return;
      const j = (await r.json()) as Screens;
      if (live) setData({ items: j.items ?? [], screenFrames: j.screenFrames ?? [] });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [hosted?.projectId, tick, Math.floor(version / 20)]);
  return { data, reload: () => setTick((t) => t + 1) };
}

const PRESETS = Object.keys(SCREEN_DEVICES) as ScreenDevicePreset[];

function DeviceFrames({ node, editable }: { node: RNode; editable: boolean }) {
  const hosted = useEditor((s) => s.hosted);
  const { data, reload } = useScreens();
  const [device, setDevice] = useState<string>('mobile');
  const [cw, setCw] = useState('1280');
  const [ch, setCh] = useState('800');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const doc = getState().doc!;
  const screen = data?.items.find((i) => i.kind === 'screen' && framesOfScreen(i, data.screenFrames).includes(node.id));
  const linked = screen ? framesOfScreen(screen, data!.screenFrames) : [];
  const taken = new Set(data?.screenFrames.filter((f) => f.screen === screen?.id && doc.findNode(f.frame)).map((f) => f.device));

  const size = (): { w: number; h: number; label: string } | null => {
    if (device !== 'custom') { const d = SCREEN_DEVICES[device as ScreenDevicePreset]; return { w: d.w, h: d.h, label: d.name }; }
    const w = Math.round(Number(cw)), h = Math.round(Number(ch));
    if (!(w >= 1 && w <= MAX_FRAME_SIZE && h >= 1 && h <= MAX_FRAME_SIZE)) { setMsg(`Width and height must be 1 to ${MAX_FRAME_SIZE}.`); return null; }
    return { w, h, label: `Custom ${w}×${h}` };
  };

  const duplicate = async () => {
    const s = size();
    if (!s) return;
    setBusy(true); setMsg('');
    try {
      if (hosted && screen) {
        const res = await fetch(`/api/projects/${hosted.projectId}/screens/${screen.id}/frames`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(device === 'custom' ? { device, w: s.w, h: s.h, from: node.id } : { device, from: node.id }),
        });
        const body = (await res.json().catch(() => ({}))) as { frame?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? 'That did not work. Try again.');
        reload();
        setMsg(`Linked ${s.label} frame added beside this one.`);
        if (body.frame) select([body.frame]);
        return;
      }
      // not linked to a screen (or the local tool): an unlinked copy at that size, placed beside the frame
      const c = liveCanvas();
      const src = c?.bounds(node.id);
      const res = await rdl(duplicateScript(doc, node.id), `duplicate to ${s.label}`);
      const id = res?.created[0];
      if (!id) return;
      const others = c ? c.order.map((f) => c.bounds(f)).filter((r): r is NonNullable<typeof r> => !!r) : [];
      const at = src ? besideFrame(src, others) : undefined;
      await rdl(`set #${id} w${s.w} h${s.h}${at ? ` at:${at.x},${at.y}` : ''}`, `size ${s.label}`);
      select([id]);
      setMsg(hosted ? 'Copied at that size. It is not linked: link this frame to a screen in IA to link copies.' : 'Copied at that size. Linked device frames need a team project.');
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setMsg(text);
      toast('error', text);
    } finally {
      setBusy(false);
    }
  };

  const page = doc.page(activePageId());
  return (
    <div className="device-frames">
      <div className="section-title">Devices</div>
      {screen && (
        <ul className="device-list" aria-label={`Frames linked to ${screen.title}`}>
          {linked.map((f) => {
            const link = data!.screenFrames.find((l) => l.frame === f);
            const on = page.nodes[f];
            return (
              <li key={f}>
                <button className="btn btn-sm-inline" aria-current={f === node.id ? 'true' : undefined} disabled={!on} onClick={() => select([f])}>
                  {deviceName(link?.device ?? 'desktop')}{link ? ` ${link.w}×${link.h}` : ''}{f === screen.data.frame ? ' · primary' : ''}{on ? '' : ' · not on this page'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!screen && hosted && data && <p className="hint">Not linked to a screen yet. Copies made here are unlinked.</p>}
      {editable && (
        <div className="device-add">
          <select className="input" aria-label="Device for the copy" value={device} onChange={(e) => setDevice(e.target.value)}>
            {PRESETS.filter((d) => !taken.has(d)).map((d) => <option key={d} value={d}>{SCREEN_DEVICES[d].name} ({SCREEN_DEVICES[d].w} × {SCREEN_DEVICES[d].h})</option>)}
            <option value="custom">Custom size</option>
          </select>
          {device === 'custom' && (
            <span className="device-custom">
              <input className="input input-sm" type="number" min={1} max={MAX_FRAME_SIZE} aria-label="Custom width" value={cw} onChange={(e) => setCw(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <span aria-hidden>×</span>
              <input className="input input-sm" type="number" min={1} max={MAX_FRAME_SIZE} aria-label="Custom height" value={ch} onChange={(e) => setCh(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            </span>
          )}
          <button className="btn" disabled={busy} onClick={() => void duplicate()}>Duplicate to device</button>
        </div>
      )}
      <p className="hint" role="status" aria-live="polite">{msg}</p>
    </div>
  );
}

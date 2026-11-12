/** Always-open stages, work types and device frames (lifecycle.ts, wireframe.ts). */
import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { applyRdl } from './rdl.js';
import { designFacts, evaluateStage, framesOfScreen, isStrict, signoffState, stagePolicy, stageWarnings, WORK_TYPES, workTypeDef, designOpenAt, STAGES, type LifecycleItem, type Signoff, type StageEvent } from './lifecycle.js';
import { deviceForWidth, duplicateFrameOps, SCREEN_DEVICES, wireframeScript } from './wireframe.js';

const item = (id: string, kind: LifecycleItem['kind'], data: Record<string, unknown> = {}, title = id): LifecycleItem => ({ id, kind, cycle: 1, title, body: '', data, status: 'open', created_by: null, created_at: '2026-01-01T00:00:00Z' });

describe('always-open stages', () => {
  it('never locks the canvas at any stage', () => {
    for (const s of STAGES) expect(designOpenAt(s.id)).toBe(true);
  });
  it('turns open checks into warnings only for stages the work type checks', () => {
    const checks = [{ id: 'screen', label: 'Screens listed', ok: false, detail: 'No screens yet' }];
    expect(stageWarnings({ id: 'ia', name: 'IA', checks, inType: true })).toEqual([{ stage: 'ia', check: 'screen', message: 'IA: Screens listed (No screens yet)' }]);
    expect(stageWarnings({ id: 'ia', name: 'IA', checks, inType: false })).toEqual([]);
  });
});

describe('work types', () => {
  it('Feature is the default and asks for Visual and Handoff approval', () => {
    const t = workTypeDef(undefined);
    expect(t.id).toBe('feature');
    expect(stagePolicy(t, 'visual')).toMatchObject({ inType: true, required: true });
    expect(stagePolicy(t, 'define')).toMatchObject({ inType: false, required: false });
  });
  it('Fix needs one approval, at Handoff', () => {
    expect(WORK_TYPES.fix.signoffs).toEqual(['handoff']);
    expect(WORK_TYPES.fix.approvals).toBe(1);
  });
  it('Regulated is always strict and needs two different approvers', () => {
    const t = WORK_TYPES.regulated;
    expect(isStrict(false, t)).toBe(true);
    expect(isStrict(false, WORK_TYPES.full)).toBe(false);
    expect(isStrict(true, WORK_TYPES.feature)).toBe(true);
    const events: StageEvent[] = [{ id: 'e', cycle: 1, kind: 'review_requested', from_stage: 'visual', to_stage: 'visual', actor: 'a', note: '', created_at: '2026-01-01T00:00:00Z' }];
    const one: Signoff[] = [{ id: 's1', cycle: 1, stage: 'visual', decision: 'approved', note: '', reviewer: 'b', created_at: '2026-01-02T00:00:00Z' }];
    const policy = stagePolicy(t, 'visual');
    expect(signoffState('visual', 1, one, events, policy)).toMatchObject({ status: 'in_review', approved: false, needed: 2 });
    // the same person twice is still one approval
    const again = [...one, { ...one[0]!, id: 's2', created_at: '2026-01-03T00:00:00Z' }];
    expect(signoffState('visual', 1, again, events, policy).approved).toBe(false);
    const two = [...one, { ...one[0]!, id: 's3', reviewer: 'c' }];
    expect(signoffState('visual', 1, two, events, policy)).toMatchObject({ status: 'approved', approved: true, roundStart: '2026-01-01T00:00:00Z' });
  });
});

describe('device frames', () => {
  const build = () => {
    const doc = createDocument('x');
    const desk = applyRdl(doc, wireframeScript('Cart', 'Review items', 'list', 'desktop')).created[0]!;
    const phone = applyRdl(doc, wireframeScript('Cart', 'Review items', 'list', 'mobile')).created[0]!;
    const pay = applyRdl(doc, wireframeScript('Pay', 'Pay', 'form', 'mobile')).created[0]!;
    return { doc, desk, phone, pay };
  };

  it('classes a frame by its width', () => {
    expect([deviceForWidth(390), deviceForWidth(834), deviceForWidth(1024), deviceForWidth(1440), deviceForWidth(null)]).toEqual(['mobile', 'tablet', 'ipad', 'desktop', 'desktop']);
    for (const [id, d] of Object.entries(SCREEN_DEVICES)) expect(deviceForWidth(d.w)).toBe(id);
  });

  it('a screen has its primary frame first, then its linked device frames', () => {
    const s = item('cart', 'screen', { frame: 'n1' });
    expect(framesOfScreen(s)).toEqual(['n1']);
    expect(framesOfScreen(s, [{ screen: 'cart', frame: 'n9', device: 'mobile', w: 390, h: 844, primary: false }, { screen: 'cart', frame: 'n1', device: 'desktop', w: 1440, h: 900, primary: true }])).toEqual(['n1', 'n9']);
    expect(framesOfScreen(item('pay', 'screen'), [{ screen: 'pay', frame: 'n4', device: 'mobile', w: 390, h: 844, primary: false }])).toEqual(['n4']);
  });

  it('gate checks count any linked frame, and flows link across devices', () => {
    const { doc, desk, phone, pay } = build();
    const cart = item('cart', 'screen', { frame: desk });
    const payScreen = item('pay', 'screen', {});
    const frames = [{ screen: 'cart', frame: phone, device: 'mobile' as const, w: 390, h: 844, primary: false }, { screen: 'pay', frame: pay, device: 'mobile' as const, w: 390, h: 844, primary: false }];
    const flow = item('buy', 'flow', { steps: ['cart', 'pay'] });
    let facts = designFacts(doc);
    const input = { cycle: 1, items: [cart, payScreen, flow], design: facts, frames };
    expect(evaluateStage('wireframes', input).find((c) => c.id === 'frame')!.ok).toBe(true);
    expect(evaluateStage('prototype', input).find((c) => c.id === 'flows')!.ok).toBe(false);
    // a link from the phone frame of Cart to Pay passes the flow, though Cart's primary frame is the desktop one
    applyRdl(doc, `proto start #${phone}\nproto #${phone}\n  click navigate #${pay}`);
    facts = designFacts(doc);
    expect(evaluateStage('prototype', { ...input, design: facts }).find((c) => c.id === 'flows')!.ok).toBe(true);
    // a linked frame that left the canvas is flagged
    applyRdl(doc, `delete #${phone}`);
    expect(evaluateStage('wireframes', { ...input, design: designFacts(doc) }).find((c) => c.id === 'devices')!.ok).toBe(false);
  });

  it('duplicate to device copies every layer at the new size, with fresh ids, next to the original', () => {
    const { doc, desk } = build();
    const before = Object.keys(doc.page().nodes).length;
    const count = [...doc.walk([desk])].length;
    const { ops, frame } = duplicateFrameOps(doc, desk, { ...SCREEN_DEVICES.ipad, label: 'iPad' });
    doc.apply(ops);
    const copy = doc.node(frame);
    expect(copy.size?.w).toEqual({ kind: 'fixed', v: 1024 });
    expect(copy.size?.h).toEqual({ kind: 'fixed', v: 1366 });
    expect(copy.name).toBe(`${doc.node(desk).name} · iPad`);
    expect([...doc.walk([frame])].length).toBe(count);
    expect(Object.keys(doc.page().nodes).length).toBe(before + count);
    expect(doc.page().children.indexOf(frame)).toBe(doc.page().children.indexOf(desk) + 1);
    // a copy of a copy does not stack device names
    const again = duplicateFrameOps(doc, frame, { w: 800, h: 600, label: 'Custom 800×600' });
    doc.apply(again.ops);
    expect(doc.node(again.frame).name).toBe(`${doc.node(desk).name} · Custom 800×600`);
    expect(() => duplicateFrameOps(doc, doc.node(desk).children![0]!, { w: 1, h: 1, label: 'x' })).toThrow(/top-level/);
  });
});

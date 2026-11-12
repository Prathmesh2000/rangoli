/**
 * The handoff bundle: every screen in RDL with its devices, tokens, flows, states, assets and spec notes.
 *
 * Built from a snapshot (by default the latest approved one), so what developers receive is the version someone
 * approved. Built from the working copy only when asked for, and then marked Unapproved.
 */
import { framesOfScreen, RangoliDocument, serializeRdl, type DocumentData, type ItemKind, type LifecycleItem, type ScreenFrameLink } from '@rangoli/engine';

export interface HandoffSource {
  project: string;
  cycle: number;
  workType: string;
  data: DocumentData;
  items: LifecycleItem[];
  frames: ScreenFrameLink[];
  annotations: { n: number; node: string; body: string }[];
}

/** What the bundle was built from: an approved snapshot, another named snapshot, or the working copy. */
export type HandoffApproval =
  | { status: 'approved'; snapshot: SnapshotRef; approvedBy: { name: string; at: string }[] }
  | { status: 'snapshot'; snapshot: SnapshotRef; approvedBy: [] }
  | { status: 'unapproved'; snapshot: null; approvedBy: [] };

export interface SnapshotRef {
  id: string;
  name: string;
  contentHash: string;
  libraryHash: string;
  canonVersion: string;
  engineVersion: string;
  signature: string;
  signingKey: string;
  createdAt: string;
  createdBy: string;
}

export function buildHandoff(src: HandoffSource, approval: HandoffApproval) {
  const doc = new RangoliDocument(structuredClone(src.data));
  const by = (k: ItemKind) => src.items.filter((i) => i.kind === k);
  const isInFrame = (node: string, frame: string | undefined) => {
    for (let cur: string | undefined = node; cur; cur = doc.findNode(cur)?.node.parent) if (cur === frame) return true;
    return false;
  };
  const rdlOf = (frame: string | undefined) => (frame && doc.findNode(frame) ? serializeRdl(doc, { roots: [frame] }) : null);
  return {
    // first, so nobody builds from a working copy without seeing that it is one
    approval: approval.status === 'unapproved' ? 'Unapproved' : approval.status === 'approved' ? 'Approved' : 'Not approved (named snapshot)',
    unapproved: approval.status === 'unapproved',
    snapshot: approval.snapshot,
    approvedBy: approval.approvedBy,
    project: src.project,
    cycle: src.cycle,
    workType: src.workType,
    problem: by('problem')[0]?.body ?? '',
    tokens: doc.data.tokens,
    assets: Object.values(doc.data.assets ?? {}),
    screens: by('screen').map((s) => {
      const frames = framesOfScreen(s, src.frames);
      return {
        annotations: src.annotations.filter((a) => frames.some((f) => isInFrame(a.node, f))).map(({ n, body }) => ({ n, body })),
        name: s.title,
        purpose: s.body,
        spec: s.data.spec ?? '',
        states: s.data.states ?? {},
        frame: s.data.frame ?? null,
        rdl: rdlOf(s.data.frame as string | undefined),
        devices: frames.map((f) => {
          const link = src.frames.find((x) => x.frame === f);
          return { device: link?.device ?? 'desktop', w: link?.w ?? null, h: link?.h ?? null, frame: f, primary: f === s.data.frame, rdl: rdlOf(f) };
        }),
      };
    }),
    flows: by('flow').map((f) => ({ name: f.title, steps: ((f.data.steps as string[] | undefined) ?? []).map((id) => src.items.find((i) => i.id === id)?.title) })),
  };
}

export type HandoffBundle = ReturnType<typeof buildHandoff>;

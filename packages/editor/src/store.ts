import { useSyncExternalStore } from 'react';
import { diffDocuments, emptyReviews, previewScript, RangoliDocument, type DocDiff, type DocumentData, type LintIssue, type ReviewData } from '@rangoli/engine';

export type Role = 'owner' | 'editor' | 'reviewer' | 'viewer';
export interface PresenceItem {
  clientId: string;
  name: string;
  role: Role | 'agent';
  selection: string[];
}
export interface Compare {
  label: string;
  before: RangoliDocument;
  after: RangoliDocument;
  diff: DocDiff;
  changeset?: string;
}
export type RightTab = 'inspect' | 'review' | 'tokens' | 'lint';

export interface HistoryItem {
  seq: number;
  author: string;
  label: string | null;
  time: number;
  touched: number;
}

export interface EditorState {
  doc: RangoliDocument | null;
  dir: string;
  seq: number;
  history: HistoryItem[];
  selection: string[];
  hover: string | null;
  mode: 'light' | 'dark';
  zoom: number;
  connected: boolean;
  /** last agent activity timestamp, for the "agent is working" indicator */
  agentActiveAt: number;
  toast: { kind: 'error' | 'info'; text: string } | null;
  lint: LintIssue[];
  /** bumps on every document change so memoized views recompute */
  version: number;
  /** bump to ask the canvas to zoom-to-fit */
  fitRequest: number;
  role: Role;
  agentMode: 'direct' | 'suggest';
  presence: PresenceItem[];
  reviews: ReviewData;
  compare: Compare | null;
  rightTab: RightTab;
  focusThread: string | null;
  myName: string;
  view: 'design' | 'icons' | 'images';
  imageSel: { kind: 'asset' | 'comp'; id: string } | null;
  /** selected icon "set/name" in Icon Studio */
  iconSel: string | null;
  /** unsaved shape source being typed (live preview) */
  iconDraft: string | null;
  /** canvas tool */
  tool: Tool;
}

export type Tool = 'select' | 'frame' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text';

let state: EditorState = {
  doc: null,
  dir: '',
  seq: 0,
  history: [],
  selection: [],
  hover: null,
  mode: (localStorageGet('rangoli.mode') as 'light' | 'dark') ?? 'light',
  zoom: 1,
  connected: false,
  agentActiveAt: 0,
  toast: null,
  lint: [],
  version: 0,
  fitRequest: 0,
  role: 'viewer',
  agentMode: 'direct',
  presence: [],
  reviews: emptyReviews(),
  compare: null,
  rightTab: 'inspect',
  focusThread: null,
  myName: localStorageGet('rangoli.name') ?? '',
  view: (['icons', 'images'] as const).find((v) => v === localStorageGet('rangoli.view')) ?? 'design',
  imageSel: null,
  iconSel: null,
  iconDraft: null,
  tool: 'select',
};

export function setTool(tool: Tool): void {
  setState({ tool });
}

export function setView(view: 'design' | 'icons' | 'images'): void {
  localStorageSet('rangoli.view', view);
  setState({ view });
}

const clientId = Math.random().toString(36).slice(2, 10);
export const myClientId = clientId;

export function requestFit(): void {
  setState({ fitRequest: state.fitRequest + 1 });
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setState(patch: Partial<EditorState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getState(): EditorState {
  return state;
}

export function useEditor<T>(select: (s: EditorState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function localStorageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode etc. */
  }
}

// ---------------------------------------------------------------- server sync

const headers = () => ({ 'content-type': 'application/json', ...(state.myName ? { 'x-rangoli-name': state.myName } : {}) });

async function post<T = unknown>(path: string, body: unknown = {}): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) toast('error', data.error ?? `Request failed (${res.status})`);
  return { ok: res.ok, data };
}

async function fetchDoc(): Promise<void> {
  const res = await fetch('/api/doc', { cache: 'no-store' });
  const body = (await res.json()) as { data: DocumentData; dir: string; seq: number; history: HistoryItem[]; selection: string[]; role: Role; agentMode: 'direct' | 'suggest'; presence: PresenceItem[] };
  const doc = new RangoliDocument(body.data);
  // drop selection of nodes that no longer exist
  const selection = state.selection.filter((id) => doc.findNode(id));
  setState({ doc, dir: body.dir, seq: body.seq, history: body.history, selection, version: state.version + 1, role: body.role, agentMode: body.agentMode, presence: body.presence });
  void refreshLint();
}

async function fetchReviews(): Promise<void> {
  const res = await fetch('/api/reviews', { cache: 'no-store' });
  if (res.ok) setState({ reviews: (await res.json()) as ReviewData });
}

async function refreshLint(): Promise<void> {
  try {
    const res = await fetch('/api/lint', { cache: 'no-store' });
    setState({ lint: (await res.json()) as LintIssue[] });
  } catch {
    /* ignore */
  }
}

let refetchTimer: number | undefined;
function scheduleRefetch() {
  window.clearTimeout(refetchTimer);
  refetchTimer = window.setTimeout(() => void fetchDoc(), 16);
}

export function connect(): () => void {
  void fetchDoc();
  void fetchReviews();
  const es = new EventSource(`/events?client=${clientId}&name=${encodeURIComponent(state.myName)}`);
  es.addEventListener('reviews', () => void fetchReviews());
  es.addEventListener('presence', (ev) => setState({ presence: JSON.parse((ev as MessageEvent<string>).data) as PresenceItem[] }));
  es.addEventListener('mode', (ev) => setState({ agentMode: JSON.parse((ev as MessageEvent<string>).data) as 'direct' | 'suggest' }));
  es.onopen = () => setState({ connected: true });
  es.onerror = () => setState({ connected: false });
  es.addEventListener('doc', (ev) => {
    const e = JSON.parse((ev as MessageEvent<string>).data) as { author: string };
    if (e.author.startsWith('agent')) setState({ agentActiveAt: Date.now() });
    scheduleRefetch();
  });
  es.addEventListener('selection', (ev) => {
    // selection from another client (e.g. preview tab) — adopt it
    const ids = JSON.parse((ev as MessageEvent<string>).data) as string[];
    if (JSON.stringify(ids) !== JSON.stringify(state.selection)) setState({ selection: ids });
  });
  return () => es.close();
}

// ---------------------------------------------------------------- actions

export function toast(kind: 'error' | 'info', text: string): void {
  setState({ toast: { kind, text } });
  window.setTimeout(() => {
    if (state.toast?.text === text) setState({ toast: null });
  }, kind === 'error' ? 6000 : 2500);
}

/** Every human edit goes through RDL on the server: same validation, same history, same undo as agents. */
export async function rdl(script: string, label?: string, parent?: string): Promise<{ created: string[] } | null> {
  const { ok, data } = await post<{ created?: string[] }>('/api/rdl', { script, label, parent });
  return ok ? { created: data.created ?? [] } : null;
}

export async function undo(): Promise<void> {
  await post('/api/undo');
}
export async function redo(): Promise<void> {
  await post('/api/redo');
}

export async function setBrand(brand: string): Promise<void> {
  await post('/api/tokens/brand', { brand });
}

let selectTimer: number | undefined;
export function select(ids: string[]): void {
  setState({ selection: ids });
  window.clearTimeout(selectTimer);
  selectTimer = window.setTimeout(() => {
    void fetch('/select', { method: 'POST', headers: headers(), body: JSON.stringify({ ids }) });
    void fetch('/api/presence', { method: 'POST', headers: headers(), body: JSON.stringify({ clientId, name: state.myName, selection: ids }) });
  }, 60);
}

// ---------------------------------------------------------------- review actions

export const canEdit = () => state.role === 'owner' || state.role === 'editor';
export const canReview = () => state.role !== 'viewer';

export function setMyName(name: string): void {
  localStorageSet('rangoli.name', name);
  setState({ myName: name });
  void fetch('/api/presence', { method: 'POST', headers: headers(), body: JSON.stringify({ clientId, name, selection: state.selection }) });
}

export function setRightTab(tab: RightTab, focusThread: string | null = null): void {
  setState({ rightTab: tab, focusThread });
}

export async function setAgentMode(mode: 'direct' | 'suggest'): Promise<void> {
  await post('/api/mode', { mode });
}

export async function addThread(node: string | null, body: string): Promise<void> {
  const { ok, data } = await post<{ id: string }>('/api/threads', { node, body });
  if (ok) setState({ focusThread: data.id });
}
export async function replyThread(id: string, body: string): Promise<void> {
  await post(`/api/threads/${id}/reply`, { body });
}
export async function resolveThread(id: string, resolved = true): Promise<void> {
  await post(`/api/threads/${id}/resolve`, { resolved });
}

/** Humans may also suggest (reviewers can't edit directly). */
export async function suggest(script: string, label: string): Promise<void> {
  const { ok } = await post('/api/changesets', { script, label });
  if (ok) toast('info', 'Suggestion sent for approval');
}

export async function decide(id: string, decision: 'accept' | 'reject'): Promise<void> {
  const { ok } = await post(`/api/changesets/${id}/${decision}`);
  if (ok) {
    if (state.compare?.changeset === id) setState({ compare: null });
    toast('info', decision === 'accept' ? `Applied ${id}` : `Rejected ${id}`);
  }
}

export async function saveVersion(name: string): Promise<void> {
  const { ok, data } = await post<{ id: string; name: string }>('/api/versions', { name });
  if (ok) toast('info', `Saved ${data.id} "${data.name}"`);
}

export function compareChangeset(id: string): void {
  const cs = state.reviews.changesets.find((c) => c.id === id);
  if (!cs || !state.doc) return;
  const p = previewScript(state.doc, cs.script);
  if (p.error) return toast('error', `${id} no longer applies: ${p.error}`);
  setState({ compare: { label: `${cs.id}: ${cs.label}`, before: state.doc, after: p.doc, diff: diffDocuments(state.doc.data, p.doc.data), changeset: id } });
}

export async function compareVersion(id: string): Promise<void> {
  if (!state.doc) return;
  const res = await fetch(`/api/versions/${id}`);
  if (!res.ok) return toast('error', `Cannot load ${id}`);
  const before = new RangoliDocument((await res.json()) as DocumentData);
  const v = state.reviews.versions.find((x) => x.id === id);
  setState({ compare: { label: `${id} "${v?.name ?? ''}" → now`, before, after: state.doc, diff: diffDocuments(before.data, state.doc.data) } });
}

export function clearCompare(): void {
  setState({ compare: null });
}

/** Friendly author label for history and comments. */
export function authorLabel(author: string): string {
  if (author.startsWith('agent')) return 'Agent';
  if (author === 'human') return 'You';
  const m = /^human:([^ ]+)(?: \(accepted (.+)\))?$/.exec(author) ?? /^human \(accepted (.+)\)$/.exec(author);
  if (!m) return author;
  const who = author.startsWith('human:') ? (m[1] === state.myName ? 'You' : m[1]!) : 'You';
  const accepted = author.startsWith('human:') ? m[2] : m[1];
  return accepted ? `${who} ✓ ${accepted.startsWith('agent') ? 'Agent' : accepted.replace(/^human:?/, '') || 'suggestion'}` : who;
}

export function setHover(id: string | null): void {
  if (state.hover !== id) setState({ hover: id });
}

export function setMode(mode: 'light' | 'dark'): void {
  localStorageSet('rangoli.mode', mode);
  setState({ mode });
}

export function setZoom(z: number): void {
  setState({ zoom: Math.min(4, Math.max(0.1, Math.round(z * 100) / 100)) });
}

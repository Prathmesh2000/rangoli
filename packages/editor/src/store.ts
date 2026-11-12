import { useSyncExternalStore } from 'react';
import { recordChange } from './changeFeed';
import { copyForChange } from './docCopy';
import { diffDocuments, emptyReviews, opScope, previewScript, RangoliDocument, type ChangeEntry, type DocDiff, type DocumentData, type LintIssue, type Page, type ReviewData, asSkin, type Skin } from '@rangoli/engine';

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
export type RightTab = 'inspect' | 'review' | 'tokens' | 'lint' | 'notes';

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
  /** light, dark or a custom theme id */
  mode: string;
  leftTab: 'layers' | 'add';
  /** the Run overlay is open */
  running: boolean;
  /** bumps to focus the Add panel's search */
  addFocus: number;
  zoom: number;
  connected: boolean;
  /** last agent activity timestamp, for the "agent is working" indicator */
  agentActiveAt: number;
  toast: { kind: 'error' | 'info'; text: string } | null;
  lint: LintIssue[];
  /** bumps on every document change so memoized views recompute */
  version: number;
  /** pages present in `doc`; null when the whole document was loaded */
  loadedPages: string[] | null;
  /** bump to ask the canvas to zoom-to-fit */
  fitRequest: number;
  role: Role;
  /** what this person may do in this design, as capabilities from the server (packages/engine/src/capabilities.ts) */
  can: string[];
  /** other people's pointers, in canvas coordinates */
  cursors: Record<string, { name: string; x: number; y: number; at: number }>;
  /** how frames are drawn: full design, clean wireframe or hand-drawn sketch */
  skin: Skin;
  /** twelve-column overlay on top-level frames */
  layoutGrid: boolean;
  /** why the canvas is read-only right now (team app only) */
  locked: string | null;
  /** opened from the team app: where "back" goes */
  hosted: { projectId: string; projectName: string; stage: string } | null;
  agentMode: 'direct' | 'suggest';
  presence: PresenceItem[];
  reviews: ReviewData;
  compare: Compare | null;
  rightTab: RightTab;
  focusThread: string | null;
  myName: string;
  view: 'design' | 'icons' | 'images' | '3d';
  imageSel: { kind: 'asset' | 'comp'; id: string } | null;
  /** selected icon "set/name" in Icon Studio */
  iconSel: string | null;
  /** unsaved shape source being typed (live preview) */
  iconDraft: string | null;
  /** canvas tool */
  tool: Tool;
  /** the page shown on the canvas; null is the document's first page */
  activePage: string | null;
}

export type Tool = 'select' | 'frame' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text';

/** '' for the local tool; /d/<project> when opened from the team app. */
let apiBase = '';
export const api = (path: string): string => apiBase + path;

let state: EditorState = {
  doc: null,
  dir: '',
  seq: 0,
  history: [],
  selection: [],
  hover: null,
  mode: localStorageGet('rangoli.mode') ?? 'light',
  leftTab: 'layers',
  running: false,
  addFocus: 0,
  zoom: 1,
  connected: false,
  agentActiveAt: 0,
  toast: null,
  lint: [],
  version: 0,
  loadedPages: null,
  fitRequest: 0,
  role: 'viewer',
  can: [],
  locked: null,
  hosted: null,
  skin: asSkin(localStorageGet('rangoli.skin')),
  layoutGrid: false,
  cursors: {},
  agentMode: 'direct',
  presence: [],
  reviews: emptyReviews(),
  compare: null,
  rightTab: 'inspect',
  focusThread: null,
  myName: localStorageGet('rangoli.name') ?? '',
  view: (['icons', 'images', '3d'] as const).find((v) => v === localStorageGet('rangoli.view')) ?? 'design',
  imageSel: null,
  iconSel: null,
  iconDraft: null,
  tool: 'select',
  activePage: null,
};

export function setTool(tool: Tool): void {
  setState({ tool });
}

export function setView(view: 'design' | 'icons' | 'images' | '3d'): void {
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
  const res = await fetch(api(path), { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) toast('error', data.error ?? `Request failed (${res.status})`);
  return { ok: res.ok, data };
}

async function fetchDoc(): Promise<void> {
  const res = await fetch(api('/api/doc?page=active'), { cache: 'no-store' });
  const body = (await res.json()) as { data: DocumentData; loadedPages?: string[] | null; dir: string; seq: number; history: HistoryItem[]; selection: string[]; role: Role; can?: string[]; agentMode: 'direct' | 'suggest'; presence: PresenceItem[]; locked?: string | null };
  const doc = new RangoliDocument(body.data);
  // drop selection of nodes that no longer exist
  const selection = state.selection.filter((id) => doc.findNode(id));
  recordChange(state.version + 1, null); // a whole new document: the canvas diffs every frame
  setState({ doc, loadedPages: body.loadedPages ?? null, dir: body.dir, seq: body.seq, history: body.history, selection, version: state.version + 1, role: body.role, can: body.can ?? [], agentMode: body.agentMode, presence: body.presence, locked: body.locked ?? null });
  void refreshLint();
}

async function fetchReviews(): Promise<void> {
  const res = await fetch(api('/api/reviews'), { cache: 'no-store' });
  if (res.ok) setState({ reviews: (await res.json()) as ReviewData });
}

async function refreshLint(): Promise<void> {
  try {
    const res = await fetch(api('/api/lint'), { cache: 'no-store' });
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

let lintTimer: number | undefined;
function scheduleLint() {
  window.clearTimeout(lintTimer);
  lintTimer = window.setTimeout(() => void refreshLint(), 400);
}

/**
 * Apply a committed change without refetching the document. True when it was applied, false when the caller
 * must refetch (out of order, or a change this client cannot apply). The data is copied, because earlier
 * views (compare, memoized panels) still hold the previous objects.
 */
function applyCommitted(entry: ChangeEntry): boolean {
  const current = state.doc;
  if (!current || entry.seq !== state.seq + 1 || state.compare) return false;
  try {
    const loaded = state.loadedPages;
    const ops = entry.ops.filter((op) => !loaded || opScope(op) === '' || loaded.includes(opScope(op)));
    // copy only what these ops write; the rest is shared with the previous version, which nobody mutates
    const doc = new RangoliDocument(copyForChange(current.data, ops, entry.touched));
    doc.applyCommitted({ ...entry, ops });
    const selection = state.selection.filter((id) => doc.findNode(id));
    const history = entry.undoOf !== undefined ? state.history.filter((h) => h.seq !== entry.undoOf) : entry.noHistory ? state.history : [...state.history, { seq: entry.seq, author: entry.author, label: entry.label ?? null, time: entry.time, touched: entry.touched.length }].slice(-50);
    recordChange(state.version + 1, entry.touched); // the canvas re-renders only the frames these reach
    setState({ doc, seq: entry.seq, history, selection, version: state.version + 1 });
    scheduleLint();
    return true;
  } catch {
    return false;
  }
}

/** Bring one more page into a partially loaded document. */
export async function loadPage(pageId: string): Promise<void> {
  const current = state.doc;
  if (!current || !state.loadedPages || state.loadedPages.includes(pageId)) return;
  const res = await fetch(api(`/api/pages/${encodeURIComponent(pageId)}`), { cache: 'no-store' });
  if (!res.ok) return toast('error', 'That page could not be loaded');
  const { page } = (await res.json()) as { page: Page; seq: number };
  const data = structuredClone(current.data);
  data.pages[pageId] = page;
  recordChange(state.version + 1, null);
  setState({ doc: new RangoliDocument(data), loadedPages: [...state.loadedPages, pageId], version: state.version + 1 });
}

/** The page on the canvas (undefined: the document's first page, which RDL edits by default). */
export function activePageId(): string | undefined {
  const s = state;
  return s.activePage && s.doc && Object.hasOwn(s.doc.data.pages, s.activePage) ? s.activePage : undefined;
}

/**
 * Show another page. Pages other than the first load on demand (per-page loading). Editing them needs the
 * server to accept a page on /api/rdl, which it does not yet, so they open read-only (see canEdit).
 */
export async function setActivePage(pageId: string): Promise<void> {
  const doc = state.doc;
  if (!doc || !Object.hasOwn(doc.data.pages, pageId)) return;
  const first = doc.data.manifest.pages[0]?.id;
  if (state.loadedPages && !state.loadedPages.includes(pageId)) await loadPage(pageId);
  setState({ activePage: pageId === first ? null : pageId, selection: [], hover: null, fitRequest: state.fitRequest + 1 });
}

/** Point the editor at one project of the team app, leaving nothing behind from the previous one. */
export function openHosted(hosted: EditorState['hosted'], name: string): void {
  apiBase = hosted ? `/d/${hosted.projectId}` : '';
  setState({ skin: hosted?.stage === 'wireframes' ? 'clean' : 'none', hosted, myName: name, doc: null, seq: 0, loadedPages: null, activePage: null, selection: [], history: [], reviews: emptyReviews(), compare: null, lint: [], presence: [], locked: null, imageSel: null, iconSel: null, iconDraft: null });
}

export function connect(): () => void {
  void fetchDoc();
  void fetchReviews();
  const es = new EventSource(`${apiBase}/events?client=${clientId}&name=${encodeURIComponent(state.myName)}`);
  es.addEventListener('reviews', () => void fetchReviews());
  es.addEventListener('journey', () => void fetchDoc());
  es.addEventListener('cursor', (ev) => {
    const c = JSON.parse((ev as MessageEvent<string>).data) as { clientId: string; name?: string; x?: number; y?: number; leave?: boolean };
    if (c.clientId === clientId) return;
    const cursors = { ...state.cursors };
    if (c.leave) delete cursors[c.clientId];
    else cursors[c.clientId] = { name: c.name ?? '', x: c.x ?? 0, y: c.y ?? 0, at: Date.now() };
    setState({ cursors });
  });
  es.addEventListener('presence', (ev) => setState({ presence: JSON.parse((ev as MessageEvent<string>).data) as PresenceItem[] }));
  es.addEventListener('mode', (ev) => setState({ agentMode: JSON.parse((ev as MessageEvent<string>).data) as 'direct' | 'suggest' }));
  es.onopen = () => setState({ connected: true });
  es.onerror = () => setState({ connected: false });
  es.addEventListener('doc', (ev) => {
    const e = JSON.parse((ev as MessageEvent<string>).data) as ChangeEntry;
    if (e.author.startsWith('agent')) setState({ agentActiveAt: Date.now() });
    if (e.seq <= state.seq && e.ops) return; // already in the document we fetched
    if (!e.ops || !applyCommitted(e)) scheduleRefetch();
  });
  es.addEventListener('selection', (ev) => {
    // Selection is per client. The server broadcasts one shared selection without saying whose it is, so it
    // is adopted only when nobody else is here: then it can only come from this person's preview tab.
    // Other people's selections arrive through presence and never replace this one.
    if (state.presence.some((p) => p.clientId !== clientId && p.role !== 'agent')) return;
    const ids = (JSON.parse((ev as MessageEvent<string>).data) as string[]).filter((id) => !state.doc || state.doc.findNode(id));
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
    void fetch(api('/select'), { method: 'POST', headers: headers(), body: JSON.stringify({ ids }) });
    void fetch(api('/api/presence'), { method: 'POST', headers: headers(), body: JSON.stringify({ clientId, name: state.myName, selection: ids }) });
  }, 60);
}

// ---------------------------------------------------------------- review actions

/** Capability checks; the server decides the same way, so these only shape the interface. */
export const can = (capability: string) => state.can.includes(capability);
/** Edits go through RDL, which the server applies to the first page: other pages stay read-only for now. */
export const canEdit = () => can('design.edit') && !activePageId();
export const canReview = () => can('comment');
export const canAcceptSuggestions = () => can('suggestion.accept');
/** who works here and how agents write: the project lead, or the person at the machine running Rangoli */
export const canManage = () => can('members.manage');

export function setMyName(name: string): void {
  localStorageSet('rangoli.name', name);
  setState({ myName: name });
  void fetch(api('/api/presence'), { method: 'POST', headers: headers(), body: JSON.stringify({ clientId, name, selection: state.selection }) });
}

export function setRightTab(tab: RightTab, focusThread: string | null = null): void {
  setState({ rightTab: tab, focusThread });
}

export async function setAgentMode(mode: 'direct' | 'suggest'): Promise<void> {
  await post('/api/mode', { mode });
}

let cursorSent = 0;
/** Only worth sending when someone else is here to see it. */
export function sendCursor(x: number, y: number): void {
  const now = Date.now();
  if (now - cursorSent < 100 || !state.presence.some((p) => p.clientId !== clientId && p.role !== 'agent')) return;
  cursorSent = now;
  void fetch(api('/api/cursor'), { method: 'POST', headers: headers(), body: JSON.stringify({ clientId, x: Math.round(x), y: Math.round(y) }) });
}
export function leaveCursor(): void {
  if (cursorSent) void fetch(api('/api/cursor'), { method: 'POST', headers: headers(), body: JSON.stringify({ clientId, leave: true }) });
  cursorSent = 0;
}

const asDataUrl = (f: File) => new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => fail(new Error('Could not read that file')); r.readAsDataURL(f); });

/** Queue work for the connected agent. Throws so the dialog can show why it failed. */
export async function askAgent(prompt: string, file: File | null, device: string): Promise<void> {
  const send = async <T,>(path: string, body: unknown) => {
    const res = await fetch(api(path), { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? 'That did not work. Try again.');
    return data;
  };
  const asset = file ? (await send<{ id: string }>('/api/assets', { name: file.name, dataUrl: await asDataUrl(file) })).id : undefined;
  await send('/api/agent-requests', { prompt, asset, device });
}

export async function cancelAgentRequest(id: string): Promise<void> {
  await post(`/api/agent-requests/${id}/cancel`);
}

export function setSkin(skin: Skin): void {
  localStorageSet('rangoli.skin', skin);
  setState({ skin });
}

export async function addAnnotation(node: string, body: string): Promise<void> {
  await post('/api/threads', { node, body, kind: 'annotation' });
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
  const res = await fetch(api(`/api/versions/${id}`));
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
  const m = /^human:(.+?)(?: \(accepted (.+)\))?$/.exec(author) ?? /^human \(accepted (.+)\)$/.exec(author);
  if (!m) return author;
  const who = author.startsWith('human:') ? (m[1] === state.myName ? 'You' : m[1]!) : 'You';
  const accepted = author.startsWith('human:') ? m[2] : m[1];
  return accepted ? `${who} ✓ ${accepted.startsWith('agent') ? 'Agent' : accepted.replace(/^human:?/, '') || 'suggestion'}` : who;
}

export function setHover(id: string | null): void {
  if (state.hover !== id) setState({ hover: id });
}

export function openAddPanel(): void {
  setState({ leftTab: 'add', addFocus: state.addFocus + 1 });
}

export function setMode(mode: string): void {
  localStorageSet('rangoli.mode', mode);
  setState({ mode });
}

export function setZoom(z: number): void {
  setState({ zoom: Math.min(4, Math.max(0.1, Math.round(z * 100) / 100)) });
}

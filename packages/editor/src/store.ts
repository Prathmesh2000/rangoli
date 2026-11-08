import { useSyncExternalStore } from 'react';
import { RangoliDocument, type DocumentData, type LintIssue } from '@rangoli/engine';

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
}

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
};

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

const JSON_HEADERS = { 'content-type': 'application/json' };

async function fetchDoc(): Promise<void> {
  const res = await fetch('/api/doc', { cache: 'no-store' });
  const body = (await res.json()) as { data: DocumentData; dir: string; seq: number; history: HistoryItem[]; selection: string[] };
  const doc = new RangoliDocument(body.data);
  // drop selection of nodes that no longer exist
  const selection = state.selection.filter((id) => doc.findNode(id));
  setState({ doc, dir: body.dir, seq: body.seq, history: body.history, selection, version: state.version + 1 });
  void refreshLint();
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
  const es = new EventSource('/events');
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
  const res = await fetch('/api/rdl', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ script, label, parent }) });
  const body = (await res.json()) as { created?: string[]; error?: string };
  if (!res.ok) {
    toast('error', body.error ?? 'Edit failed');
    return null;
  }
  return { created: body.created ?? [] };
}

export async function undo(): Promise<void> {
  await fetch('/api/undo', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}
export async function redo(): Promise<void> {
  await fetch('/api/redo', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}

export async function setBrand(brand: string): Promise<void> {
  const res = await fetch('/api/tokens/brand', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ brand }) });
  if (!res.ok) toast('error', ((await res.json()) as { error: string }).error);
}

let selectTimer: number | undefined;
export function select(ids: string[]): void {
  setState({ selection: ids });
  window.clearTimeout(selectTimer);
  selectTimer = window.setTimeout(() => {
    void fetch('/select', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids }) });
  }, 60);
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

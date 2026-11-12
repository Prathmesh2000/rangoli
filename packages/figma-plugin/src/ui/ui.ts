import { z } from 'zod';

import type { ExportPhase } from '../host.js';
import { LIMITS } from '../limits.js';
import type { FrameSummary, MainToUi, PageSummary, UiToMain } from '../protocol.js';
import { parseFigmaExport, type FigmaExport } from '../schema.js';
import { SERVERS, UploadError, isPlausibleToken, uploadExport } from '../upload.js';
import { SelectionModel } from './selection.js';

// Plugin iframes may forbid eval; this also avoids noisy CSP reports.
z.config({ jitless: true });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const treeEl = $<HTMLUListElement>('tree');
const statusEl = $<HTMLDivElement>('status');
const countEl = $<HTMLSpanElement>('count');
const tokenEl = $<HTMLInputElement>('token');
const serverEl = $<HTMLSelectElement>('server');
const uploadEl = $<HTMLButtonElement>('upload');
const downloadEl = $<HTMLButtonElement>('download');
const imagesEl = $<HTMLInputElement>('images');
const previewsEl = $<HTMLInputElement>('previews');

const selection = new SelectionModel();
let pages: PageSummary[] = [];
let fileName = 'figma-file';
let busy = false;
let pendingAction: 'upload' | 'download' | null = null;
let uploadAbort: AbortController | null = null;

const expanded = new Set<string>();
const frameRequests = new Set<string>();
const frames = new Map<string, { frames: FrameSummary[]; total: number }>();
const frameErrors = new Map<string, string>();

function send(message: UiToMain): void {
  parent.postMessage({ pluginMessage: message }, '*');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // Layer and page names are untrusted: always textContent, never innerHTML.
  if (text !== undefined) node.textContent = text;
  return node;
}

function requestFrames(pageId: string): void {
  if (frames.has(pageId) || frameRequests.has(pageId)) return;
  frameRequests.add(pageId);
  frameErrors.delete(pageId);
  send({ type: 'list-frames', pageId });
}

function renderTree(): void {
  const scrollTop = treeEl.scrollTop;
  treeEl.replaceChildren(...pages.map(renderPage));
  treeEl.scrollTop = scrollTop;
  updateControls();
}

function renderPage(page: PageSummary): HTMLLIElement {
  const li = el('li');
  const row = el('div', 'row');

  const disclose = el('button', 'disclose');
  disclose.type = 'button';
  disclose.setAttribute('aria-expanded', String(expanded.has(page.id)));
  disclose.setAttribute('aria-label', `Show frames in ${page.name}`);
  disclose.addEventListener('click', () => {
    if (expanded.has(page.id)) expanded.delete(page.id);
    else {
      expanded.add(page.id);
      requestFrames(page.id);
    }
    renderTree();
  });

  const label = el('label');
  const box = el('input');
  box.type = 'checkbox';
  const state = selection.pageState(page.id);
  box.checked = state === 'all';
  box.indeterminate = state === 'some';
  box.addEventListener('change', () => {
    selection.setPage(page.id, box.checked);
    renderTree();
  });
  label.append(box, el('span', 'name', page.name));
  row.append(disclose, label);
  li.append(row);

  if (expanded.has(page.id)) li.append(renderFrames(page.id));
  return li;
}

function renderFrames(pageId: string): HTMLElement {
  const error = frameErrors.get(pageId);
  if (error) return el('div', 'hint error', `Could not load this page: ${error}`);

  const listing = frames.get(pageId);
  if (!listing) return el('div', 'hint', 'Loading page');
  if (listing.frames.length === 0) return el('div', 'hint', 'This page is empty.');

  const ul = el('ul');
  for (const frame of listing.frames) {
    const li = el('li');
    const row = el('div', 'row');
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = selection.isFrameChecked(pageId, frame.id);
    box.addEventListener('change', () => {
      selection.setFrame(pageId, frame.id, box.checked);
      renderTree();
    });
    label.append(box, el('span', 'name', frame.name));
    row.append(label);
    li.append(row);
    ul.append(li);
  }
  if (listing.total > listing.frames.length) {
    const more = el('li', 'hint', `Showing ${listing.frames.length} of ${listing.total}. Tick the page to take them all.`);
    ul.append(more);
  }
  return ul;
}

function updateControls(): void {
  const empty = selection.isEmpty();
  const chosen = selection.toSelection(pages.map((p) => p.id)).pages.length;
  countEl.textContent = chosen === 0 ? '' : `${chosen} ${chosen === 1 ? 'page' : 'pages'}`;

  uploadEl.disabled = busy || empty || !isPlausibleToken(tokenEl.value.trim());
  downloadEl.disabled = busy || empty;
  imagesEl.disabled = busy;
  previewsEl.disabled = busy;
  serverEl.disabled = busy;
  tokenEl.disabled = busy;
}

function setBusy(next: boolean): void {
  busy = next;
  updateControls();
}

function showProgress(text: string, value?: number, max?: number, onCancel?: () => void): void {
  const line = el('div', 'status-line');
  line.append(el('span', undefined, text));
  if (onCancel) {
    const cancel = el('button', 'link', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', onCancel);
    line.append(cancel);
  }
  const bar = el('progress');
  if (value !== undefined && max) {
    bar.max = max;
    bar.value = value;
  }
  statusEl.replaceChildren(line, bar);
}

function showError(message: string, details: string[] = []): void {
  const nodes: HTMLElement[] = [el('div', 'status-line error', message)];
  if (details.length > 0) {
    const list = el('ul', 'gaps');
    for (const detail of details) list.append(el('li', undefined, detail));
    nodes.push(list);
  }
  statusEl.replaceChildren(...nodes);
}

function renderGaps(data: FigmaExport): HTMLElement | null {
  if (data.gapSummary.length === 0) return null;
  const total = data.gapSummary.reduce((sum, gap) => sum + gap.count, 0);
  const details = el('details');
  details.append(el('summary', undefined, `${total} items could not be fully captured`));
  const list = el('ul', 'gaps');
  const rank = { error: 0, warning: 1, info: 2 } as const;
  for (const gap of [...data.gapSummary].sort((a, b) => rank[a.severity] - rank[b.severity])) {
    const li = el('li');
    li.append(el('span', undefined, gap.code), el('span', 'count', String(gap.count)));
    list.append(li);
  }
  details.append(list);
  return details;
}

function showDone(message: string, data: FigmaExport): void {
  const nodes: HTMLElement[] = [el('div', 'status-line', message)];
  if (!data.stats.complete) {
    nodes.push(el('div', 'status-line error', 'A size limit stopped this export early. Choose fewer frames for a complete import.'));
  }
  const gaps = renderGaps(data);
  if (gaps) nodes.push(gaps);
  statusEl.replaceChildren(...nodes);
}

const PHASE_LABEL: Record<ExportPhase, string> = {
  layers: 'Reading layers',
  components: 'Reading components',
  variables: 'Reading variables',
  styles: 'Reading styles',
  images: 'Reading images',
  previews: 'Rendering previews',
};

function startExport(action: 'upload' | 'download'): void {
  if (busy || selection.isEmpty()) return;
  pendingAction = action;
  setBusy(true);
  showProgress('Reading layers', undefined, undefined, () => send({ type: 'cancel' }));
  send({
    type: 'export',
    selection: selection.toSelection(pages.map((p) => p.id)),
    options: { includeImages: imagesEl.checked, includePreviews: previewsEl.checked },
  });
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80);
  return `${cleaned || 'figma-file'}.rangoli-figma.json`;
}

function downloadJson(json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = safeFileName(fileName);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function finishExport(data: FigmaExport): Promise<void> {
  const action = pendingAction;
  pendingAction = null;
  showProgress('Checking export');
  // Let the status paint before the synchronous work below.
  await new Promise((resolve) => setTimeout(resolve, 0));

  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    showError('This export is too large to prepare. Choose fewer frames or leave out images.');
    setBusy(false);
    return;
  }

  // The same entry point the server will use, so a pass here predicts a pass there.
  const parsed = parseFigmaExport(json);
  if (!parsed.ok) {
    showError(`${parsed.error} Nothing was sent.`, parsed.issues.map((i) => `${i.path}: ${i.message}`));
    setBusy(false);
    return;
  }

  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > LIMITS.maxExportBytes) {
    showError('This export is over the size limit. Choose fewer frames or leave out images.');
    setBusy(false);
    return;
  }

  if (action === 'download') {
    downloadJson(json);
    showDone('JSON file downloaded.', parsed.data);
    setBusy(false);
    return;
  }

  const abort = new AbortController();
  uploadAbort = abort;
  const token = tokenEl.value.trim();
  try {
    const onCancel = () => abort.abort();
    showProgress('Uploading', 0, bytes.byteLength, onCancel);
    const { importId } = await uploadExport({
      serverUrl: serverEl.value,
      token,
      bytes,
      signal: abort.signal,
      onProgress: (sent, total) => showProgress('Uploading', sent, total, onCancel),
    });
    showDone(`Uploaded. Import ${importId} is ready in Rangoli.`, parsed.data);
  } catch (error) {
    if (error instanceof UploadError) {
      if (error.code === 'cancelled') statusEl.replaceChildren(el('div', 'status-line', 'Upload cancelled. Create a new token to try again.'));
      else showError(error.message);
    } else {
      showError('The upload stopped unexpectedly. Create a new token and try again.');
    }
  } finally {
    // The token is one-use, so it never survives an attempt.
    tokenEl.value = '';
    uploadAbort = null;
    setBusy(false);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = (event.data as { pluginMessage?: MainToUi } | null)?.pluginMessage;
  if (!message) return;

  switch (message.type) {
    case 'init':
      fileName = message.fileName;
      $('file-name').textContent = message.fileName;
      $('file-name').title = message.fileName;
      pages = message.pages;
      if (message.currentPageId !== null) {
        expanded.add(message.currentPageId);
        requestFrames(message.currentPageId);
      }
      renderTree();
      break;
    case 'frames':
      frameRequests.delete(message.pageId);
      frames.set(message.pageId, { frames: message.frames, total: message.total });
      selection.setKnownFrames(message.pageId, message.frames.map((f) => f.id));
      renderTree();
      break;
    case 'frames-error':
      frameRequests.delete(message.pageId);
      frameErrors.set(message.pageId, message.message);
      renderTree();
      break;
    case 'progress': {
      const label = message.phase === 'layers' ? `Reading layers (${message.done})` : PHASE_LABEL[message.phase];
      showProgress(label, message.total ? message.done : undefined, message.total ?? undefined, () => send({ type: 'cancel' }));
      break;
    }
    case 'export-result':
      void finishExport(message.data);
      break;
    case 'export-error':
      pendingAction = null;
      showError(`The export failed: ${message.message}`);
      setBusy(false);
      break;
    case 'export-cancelled':
      pendingAction = null;
      statusEl.replaceChildren(el('div', 'status-line', 'Export cancelled.'));
      setBusy(false);
      break;
  }
});

for (const server of SERVERS) {
  const option = el('option', undefined, server.label);
  option.value = server.url;
  serverEl.append(option);
}
tokenEl.addEventListener('input', updateControls);
$<HTMLFormElement>('form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!uploadEl.disabled) startExport('upload');
});
downloadEl.addEventListener('click', () => startExport('download'));

window.addEventListener('beforeunload', () => uploadAbort?.abort());
updateControls();

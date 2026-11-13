import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { probe } from './imaging.js';
import {
  EXT,
  type AgentRequest,
  type AssetMeta,
  applyRdl,
  cloneDocument,
  createDocument,
  emptyReviews,
  reviewId,
  type Attribution,
  type ChangeEntry,
  type ChangeSet,
  type DefaultTokenOptions,
  type DocumentData,
  type RangoliDocument,
  type ReviewData,
  type Severity,
  type Thread,
  type VersionMeta,
} from '@rangoli/engine';
import { hydrateDocument, loadDocument, saveDocument } from '@rangoli/engine/io';
import { designLogEnabled, FileDesignLog, materialize, type DesignLog } from './design/log.js';
import { ProjectActor } from './design/project-actor.js';
import { LocalAgentPlatform, type AgentPlatform, type NewTask, type TaskView } from './design/agent-platform.js';
import { RunLedger, undoRun, type RunTaggedEntry, type RunUndoReport } from './design/runs.js';

/** The named run the current tool call writes in; every change made inside it is tagged with the run's id. */
export const currentRun = new AsyncLocalStorage<string>();

/** Where a document lives: a folder for the local tool, the database for the hosted app. */
export interface DesignStore {
  /** folder path, or '' when there is none to show */
  readonly location: string;
  saveDocument(doc: RangoliDocument): Promise<void>;
  saveReviews(reviews: ReviewData & { agentMode: AgentMode }): Promise<void>;
  loadReviews(): Promise<(Partial<ReviewData> & { agentMode?: AgentMode }) | null>;
  putAsset(file: string, mime: string, buf: Buffer): Promise<void>;
  readAssetFile(file: string): Promise<Buffer | null>;
  assetDataUri(meta: AssetMeta): string;
  /** load asset bytes so assetDataUri can answer synchronously */
  warmAssets?(): Promise<void>;
  putVersion(id: string, data: DocumentData): Promise<void>;
  getVersion(id: string): Promise<DocumentData | null>;
  /** called synchronously when a change happens, so the store can attribute the later save */
  noteDocChange?(): void;
  noteReviewChange?(): void;
  /** the durable operation log; when present, changes commit here and whole-document saves become a compatibility copy */
  readonly log?: DesignLog;
  /** the log is authoritative, but the folder format should still track edits between restarts */
  readonly continuousSave?: boolean;
  /** identifies who is editing, so undo stays per-author */
  readonly attribution?: Attribution;
  /** the log refused a change; memory was rolled back, so reload from the store */
  noteLogRefused?(): void;
}

export class FileStore implements DesignStore {
  /** on behind the RANGOLI_DESIGN_LOG flag; the plain folder format stays the default */
  readonly log: DesignLog | undefined;
  readonly continuousSave = true;
  constructor(readonly location: string) {
    this.log = designLogEnabled() ? new FileDesignLog(location) : undefined;
  }
  saveDocument(doc: RangoliDocument): Promise<void> {
    return saveDocument(doc, this.location);
  }
  async saveReviews(reviews: ReviewData & { agentMode: AgentMode }): Promise<void> {
    await writeFile(join(this.location, 'reviews.json'), JSON.stringify(reviews, null, 2) + '\n');
  }
  async loadReviews() {
    const file = join(this.location, 'reviews.json');
    return existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as Partial<ReviewData> & { agentMode?: AgentMode }) : null;
  }
  async putAsset(file: string, _mime: string, buf: Buffer): Promise<void> {
    await mkdir(join(this.location, 'assets'), { recursive: true });
    if (!existsSync(join(this.location, 'assets', file))) await writeFile(join(this.location, 'assets', file), buf);
  }
  async readAssetFile(file: string): Promise<Buffer | null> {
    const p = join(this.location, 'assets', file);
    return existsSync(p) ? readFile(p) : null;
  }
  assetDataUri(meta: AssetMeta): string {
    try {
      return `data:${meta.mime};base64,${readFileSync(join(this.location, 'assets', meta.file)).toString('base64')}`;
    } catch {
      return '';
    }
  }
  async putVersion(id: string, data: DocumentData): Promise<void> {
    await mkdir(join(this.location, 'versions'), { recursive: true });
    await writeFile(join(this.location, 'versions', `${id}.json`), JSON.stringify(data) + '\n');
  }
  async getVersion(id: string): Promise<DocumentData | null> {
    const file = join(this.location, 'versions', `${id}.json`);
    return existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as DocumentData) : null;
  }
}

export type Role = 'owner' | 'editor' | 'reviewer' | 'viewer';
export type AgentMode = 'direct' | 'suggest';

export interface Presence {
  clientId: string;
  name: string;
  role: Role | 'agent';
  selection: string[];
  lastSeen: number;
}

export interface SessionEvents {
  change: [ChangeEntry];
  saved: [];
  selection: [string[]];
  reviews: [];
  presence: [Presence[]];
  mode: [AgentMode];
  agentRequestDone: [AgentRequest];
  /** notes, tasks or runs changed */
  agents: [];
}

/**
 * One open document: load, autosave (debounced), reviews (comments, suggestions, versions),
 * presence, sharing — and broadcast changes to editor/preview clients.
 */
export class Session extends EventEmitter<SessionEvents> {
  private saveTimer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();
  selection: string[] = [];
  reviews: ReviewData = emptyReviews();
  agentMode: AgentMode = 'direct';
  readonly presence = new Map<string, Presence>();
  /** share token → role (in memory only; links die with the server) */
  readonly shareTokens = new Map<string, Role>();

  private docDirty = false;
  private reviewsDirty = false;
  private actor: ProjectActor | undefined;
  /** every recent change with its run, for whole-run undo and changes_since */
  readonly ledger = new RunLedger();
  /** notes, tasks, job leases and runs; hosted projects swap in the database adapter */
  platform: AgentPlatform;
  private detachPlatform: (() => void) | undefined;

  private constructor(readonly store: DesignStore, readonly doc: RangoliDocument) {
    super();
    this.platform = new LocalAgentPlatform(store.location);
    this.attachPlatform();
    doc.onChange((entry) => {
      const runId = currentRun.getStore();
      if (runId) (entry as RunTaggedEntry).runId = runId;
      this.ledger.record(entry);
      this.docDirty = true;
      this.store.noteDocChange?.();
      if (this.actor) {
        // published after the commit: nothing the log has not accepted reaches a client
        this.actor.enqueue(entry);
        if (this.store.continuousSave) this.scheduleSave();
      } else {
        this.emit('change', entry);
        this.scheduleSave();
      }
    });
  }

  private startLog(log: DesignLog, loaded: { counters?: Map<string, { ops: number; bytes: number }>; bootstrapped: boolean }): void {
    this.actor = new ProjectActor(this.doc, log, {
      ...loaded,
      onCommitted: (entries) => {
        for (const entry of entries) this.emit('change', entry);
        this.emit('saved');
      },
      onRefused: (e) => {
        console.error('[rangoli] a commit was refused; the unsaved changes were rolled back:', e instanceof Error ? e.message : e);
        this.store.noteLogRefused?.();
      },
    });
  }

  /** True when changes commit to the operation log instead of the debounced whole-document save. */
  get logEnabled(): boolean {
    return !!this.actor;
  }

  /** Resolves once every change so far is durable. Rejects if any was rolled back. */
  durable(): Promise<void> {
    return this.actor ? this.actor.commit() : Promise.resolve();
  }

  get dir(): string {
    return this.store.location;
  }

  static async fromStore(store: DesignStore, initial: RangoliDocument): Promise<Session> {
    let doc = initial;
    let log: Parameters<Session['startLog']>[1] | undefined;
    if (store.log) {
      const loaded = await store.log.load();
      if (loaded) {
        const m = materialize(loaded);
        doc = hydrateDocument(m.doc.data);
        doc.restoreHistory(loaded.rows, loaded.headSeq);
        log = { counters: m.counters, bootstrapped: true };
      } else log = { bootstrapped: false };
      doc.attribution = store.attribution;
    }
    const s = new Session(store, doc);
    if (store.log && log) s.startLog(store.log, log);
    const r = await store.loadReviews();
    if (r) {
      const { agentMode, ...rest } = r;
      s.reviews = { ...emptyReviews(), ...rest };
      if (agentMode === 'suggest') s.agentMode = 'suggest';
    }
    return s;
  }

  static async open(dir: string): Promise<Session> {
    const abs = resolve(dir);
    return Session.fromStore(new FileStore(abs), await loadDocument(abs));
  }

  static async create(dir: string, name: string, tokens: DefaultTokenOptions = {}): Promise<Session> {
    const abs = resolve(dir);
    if (existsSync(resolve(abs, 'manifest.json'))) throw new Error(`A Rangoli document already exists at ${abs}`);
    const doc = createDocument(name, tokens);
    await saveDocument(doc, abs);
    return Session.fromStore(new FileStore(abs), doc);
  }

  static async openOrCreate(dir: string, name = 'Untitled'): Promise<Session> {
    return existsSync(resolve(dir, 'manifest.json')) ? Session.open(dir) : Session.create(dir, name);
  }

  setSelection(ids: string[]): void {
    this.selection = ids;
    this.emit('selection', ids);
  }

  // ---------------------------------------------------------------- persistence

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(!this.actor || !!this.store.continuousSave), 150);
  }

  /** Persist now (waits for any in-flight save). */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    await this.actor?.commit().catch(() => undefined); // a refusal is already rolled back and reported
    return this.persist(true);
  }

  private persist(includeDoc: boolean): Promise<void> {
    this.saving = this.saving
      .then(async () => {
        // only what changed: a reviewer's comment must not rewrite the design under their identity
        if (includeDoc && this.docDirty) {
          this.docDirty = false;
          await this.store.saveDocument(this.doc);
        }
        if (this.reviewsDirty) {
          this.reviewsDirty = false;
          await this.store.saveReviews({ ...this.reviews, agentMode: this.agentMode });
        }
      })
      .then(() => {
        this.emit('saved');
      });
    return this.saving;
  }

  private reviewsChanged() {
    this.reviewsDirty = true;
    this.store.noteReviewChange?.();
    this.emit('reviews');
    this.scheduleSave();
  }

  // ---------------------------------------------------------------- agent mode

  setAgentMode(mode: AgentMode): void {
    this.agentMode = mode;
    this.reviewsDirty = true;
    this.store.noteReviewChange?.();
    this.emit('mode', mode);
    this.scheduleSave();
  }

  // ---------------------------------------------------------------- comments & review pins

  addThread(input: { node: string | null; author: string; body: string; kind?: Thread['kind']; severity?: Severity; fix?: string; title?: string }): Thread {
    if (input.node && !this.doc.findNode(input.node)) throw new Error(`#${input.node} not found`);
    const now = Date.now();
    const t: Thread = {
      id: reviewId('t', this.reviews.threads),
      node: input.node,
      kind: input.kind ?? 'comment',
      severity: input.severity,
      fix: input.fix,
      title: input.title,
      resolved: false,
      comments: [{ id: 'c1', author: input.author, body: input.body, time: now }],
      time: now,
    };
    this.reviews.threads.push(t);
    this.reviewsChanged();
    return t;
  }

  reply(threadId: string, author: string, body: string): Thread {
    const t = this.thread(threadId);
    t.comments.push({ id: `c${t.comments.length + 1}`, author, body, time: Date.now() });
    t.resolved = false;
    this.reviewsChanged();
    return t;
  }

  resolveThread(threadId: string, resolved = true): Thread {
    const t = this.thread(threadId);
    t.resolved = resolved;
    this.reviewsChanged();
    return t;
  }

  thread(id: string): Thread {
    const t = this.reviews.threads.find((x) => x.id === id);
    if (!t) throw new Error(`Thread ${id} not found`);
    return t;
  }

  // ---------------------------------------------------------------- suggestions (change sets)

  addChangeset(input: { author: string; label: string; script: string }): ChangeSet {
    const cs: ChangeSet = {
      id: reviewId('cs', this.reviews.changesets),
      author: input.author,
      label: input.label,
      script: input.script,
      status: 'pending',
      time: Date.now(),
      baseSeq: this.doc.historyEntries.at(-1)?.seq ?? 0,
    };
    this.reviews.changesets.push(cs);
    this.reviewsChanged();
    return cs;
  }

  changeset(id: string): ChangeSet {
    const cs = this.reviews.changesets.find((x) => x.id === id);
    if (!cs) throw new Error(`Suggestion ${id} not found`);
    return cs;
  }

  /** Accept → apply on the CURRENT document (one undoable change). Conflicts keep it pending with a message. */
  decideChangeset(id: string, decision: 'accept' | 'reject', by: string): ChangeSet {
    const cs = this.changeset(id);
    if (cs.status !== 'pending') throw new Error(`${id} is already ${cs.status}`);
    if (decision === 'accept') {
      try {
        applyRdl(this.doc, cs.script, { author: `${by} (accepted ${cs.author})`, label: `accept ${cs.id}: ${cs.label}` });
        delete cs.conflict;
      } catch (e) {
        cs.conflict = e instanceof Error ? e.message : String(e);
        this.reviewsChanged();
        throw new Error(`Cannot apply ${id} — the design changed since it was suggested:\n${cs.conflict}`);
      }
    }
    cs.status = decision === 'accept' ? 'accepted' : 'rejected';
    cs.decidedBy = by;
    cs.decidedAt = Date.now();
    this.reviewsChanged();
    return cs;
  }

  // ---------------------------------------------------------------- notes and tasks for agents

  /** Use another adapter for notes, tasks and runs (the hosted app's database). */
  usePlatform(platform: AgentPlatform): void {
    this.detachPlatform?.();
    this.platform = platform;
    this.attachPlatform();
  }

  private attachPlatform(): void {
    const platform = this.platform;
    let pending: NodeJS.Timeout | undefined;
    const changed = () => {
      this.emit('agents');
      clearTimeout(pending);
      pending = setTimeout(() => void this.syncRequests(), 50);
      pending.unref?.();
    };
    const done = (task: TaskView) => {
      const r = this.reviews.requests.find((x) => (x as AgentRequest & { taskId?: string }).taskId === task.id);
      if (!r) return;
      r.status = 'done';
      r.frame = task.frame;
      this.reviewsChanged();
      this.emit('agentRequestDone', r);
    };
    platform.on('changed', changed);
    platform.on('taskDone', done);
    this.detachPlatform = () => {
      platform.off('changed', changed);
      platform.off('taskDone', done);
    };
  }

  /** Leave a note or task for agents. The caller has checked that this person may (task.create). */
  createTask(input: NewTask): Promise<TaskView> {
    if (input.target?.node && !this.doc.findNode(input.target.node)) throw new Error(`#${input.target.node} not found`);
    return this.platform.createTask(input);
  }

  /**
   * Older entry points (the screenshot request, planned wireframes) leave their work as tasks too. The request
   * row in the reviews data is kept as the editor's view of that task and follows its status.
   */
  addRequest(input: Pick<AgentRequest, 'author' | 'prompt' | 'asset' | 'device' | 'screen'>): AgentRequest {
    const r: AgentRequest = { ...input, id: reviewId('ar', this.reviews.requests), status: 'pending', time: Date.now() };
    this.reviews.requests.push(r);
    this.reviewsChanged();
    const authorName = input.author.replace(/^human:/, '') || 'Someone';
    void this.platform
      .createTask({ kind: 'task', body: input.prompt || 'Rebuild the attached image as editable layers.', authorName, screen: input.screen, asset: input.asset, device: input.device })
      .then((task) => {
        (r as AgentRequest & { taskId?: string }).taskId = task.id;
        this.reviewsChanged();
      })
      .catch((e: unknown) => {
        r.status = 'failed';
        r.note = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        this.reviewsChanged();
      });
    return r;
  }

  /** The request rows follow their tasks' statuses. */
  private async syncRequests(): Promise<void> {
    const linked = this.reviews.requests.filter((r) => (r as AgentRequest & { taskId?: string }).taskId && r.status !== 'cancelled');
    if (!linked.length) return;
    let tasks: TaskView[];
    try {
      tasks = await this.platform.listTasks();
    } catch {
      return;
    }
    let changed = false;
    for (const r of linked) {
      const t = tasks.find((x) => x.id === (r as AgentRequest & { taskId?: string }).taskId);
      if (!t) continue;
      const status: AgentRequest['status'] = t.status === 'waiting_for_agent' ? 'pending' : t.status === 'done_ready_to_review' ? 'done' : t.status === 'could_not_complete' ? 'failed' : 'working';
      if (status !== r.status || (t.frame && t.frame !== r.frame)) {
        r.status = status;
        if (t.frame) r.frame = t.frame;
        if (t.failureReason) r.note = t.failureReason.slice(0, 500);
        changed = true;
      }
    }
    if (changed) this.reviewsChanged();
  }

  async cancelRequest(id: string): Promise<AgentRequest> {
    const r = this.reviews.requests.find((x) => x.id === id);
    if (!r) throw new Error(`Request ${id} not found`);
    const taskId = (r as AgentRequest & { taskId?: string }).taskId;
    if (r.status === 'pending') {
      if (taskId) await this.platform.withdrawTask(taskId);
      r.status = 'cancelled';
      this.reviewsChanged();
    }
    return r;
  }

  // ---------------------------------------------------------------- pages

  /**
   * Add an empty page. The engine has no page op yet, so this is not an undo step and is saved with the whole
   * document; with the operation log on, a page needs that op to survive a reload, so it is refused there.
   */
  createPage(name: string): { id: string; name: string } {
    if (this.logEnabled) throw new Error('Adding pages is not available while the operation log is on.');
    const clean = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'Page';
    const ids = new Set(this.doc.data.manifest.pages.map((p) => p.id));
    let n = ids.size + 1;
    while (ids.has(`p${n}`)) n++;
    const id = `p${n}`;
    this.doc.data.manifest.pages.push({ id, name: clean });
    this.doc.data.pages[id] = { id, name: clean, children: [], nodes: {} };
    this.docDirty = true;
    this.store.noteDocChange?.();
    this.scheduleSave();
    this.emit('saved');
    return { id, name: clean };
  }

  // ---------------------------------------------------------------- named runs

  /** Run `fn` inside a named run: its changes carry the run id, and its writes count as the run's heartbeat. */
  async inRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.doc.headSeq;
    try {
      return await currentRun.run(runId, fn);
    } finally {
      const writes = this.ledger.since(before).filter((e) => e.runId === runId).length;
      if (writes) await this.platform.noteRunWrite(runId, writes).catch(() => undefined);
    }
  }

  /**
   * Every change after `seq`, oldest first, with run ids. From the durable log when there is one, else from
   * memory, which reaches back to when this document was opened.
   */
  async entriesSince(seq: number): Promise<RunTaggedEntry[]> {
    const log = this.store.log;
    if (log?.readSince) {
      await this.durable().catch(() => undefined);
      return log.readSince(seq);
    }
    const oldest = this.ledger.oldest;
    if (oldest !== undefined && oldest > seq + 1 && seq < this.doc.headSeq) {
      throw new Error(`Changes before #${oldest} are no longer in memory. Turn on the operation log (RANGOLI_DESIGN_LOG) to undo older runs.`);
    }
    return this.ledger.since(seq);
  }

  /** A person's Undo whole run: one change of theirs, keeping whatever others changed after the run. */
  async undoRun(runId: string, by: { id?: string; name: string; author: string }): Promise<RunUndoReport> {
    const run = await this.platform.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.status === 'running') throw new Error(`Run ${run.no} is still open. Wait for the agent to end it before undoing it.`);
    if (run.status === 'undone') throw new Error(`Run ${run.no} was already undone`);
    const entries = await this.entriesSince(run.startSeq);
    const report = undoRun(this.doc, entries, runId, { author: by.author, label: `run ${run.no} (${run.agentName})` });
    await this.durable();
    await this.platform.markRunUndone(runId, by, { reverted: report.reverted, stayed: report.stayed, message: report.message });
    return report;
  }

  // ---------------------------------------------------------------- versions

  async saveVersion(name: string, author: string): Promise<VersionMeta> {
    const v: VersionMeta = { id: reviewId('v', this.reviews.versions), name, author, time: Date.now(), seq: this.doc.headSeq };
    await this.store.putVersion(v.id, cloneDocument(this.doc).data);
    this.reviews.versions.push(v);
    this.reviewsChanged();
    return v;
  }

  async loadVersion(id: string): Promise<DocumentData> {
    if (!/^v\d+$/.test(id)) throw new Error(`Bad version id ${id}`);
    const data = await this.store.getVersion(id);
    if (!data) throw new Error(`Version ${id} not found`);
    return data;
  }

  // ---------------------------------------------------------------- presence & sharing

  touchPresence(p: Omit<Presence, 'lastSeen'>): void {
    this.presence.set(p.clientId, { ...p, lastSeen: Date.now() });
    this.emit('presence', this.presenceList());
  }

  dropPresence(clientId: string): void {
    if (this.presence.delete(clientId)) this.emit('presence', this.presenceList());
  }

  presenceList(): Presence[] {
    return [...this.presence.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- assets (content-addressed files)

  /** Store bytes once (sha256), register metadata as an undoable change. */
  async addAsset(buf: Buffer, mime: string, name: string, extra: Partial<AssetMeta> & { source: AssetMeta['source'] }, author: string): Promise<AssetMeta> {
    const ext = mime === 'model/gltf-binary' ? 'glb' : EXT[mime];
    if (!ext) throw new Error(`Unsupported file type ${mime} (png, jpeg, webp, gif, svg, avif)`);
    if (buf.length > 15 * 1024 * 1024) throw new Error('File larger than 15 MB');
    const id = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const existing = this.doc.data.assets?.[id];
    if (existing) return existing;
    const { w, h } = mime.startsWith('model/') ? { w: 0, h: 0 } : probe(buf, mime);
    const file = `${id}.${ext}`;
    await this.store.putAsset(file, mime, buf);
    const meta: AssetMeta = { id, name: name.slice(0, 80) || file, file, mime, w, h, bytes: buf.length, time: Date.now(), ...extra };
    this.doc.apply([{ op: 'setAsset', id, meta }], { author, label: `${extra.source} ${meta.name}` });
    return meta;
  }

  async readAsset(meta: AssetMeta): Promise<Buffer> {
    const buf = await this.store.readAssetFile(meta.file);
    if (!buf) throw new Error(`Asset ${meta.id} is missing`);
    return buf;
  }

  /** data: URI for screenshots/compose (headless pages cannot fetch local files). */
  assetDataUri = (meta: AssetMeta): string => this.store.assetDataUri(meta);

  createShareToken(role: Exclude<Role, 'owner'>): string {
    const token = randomBytes(18).toString('base64url');
    this.shareTokens.set(token, role);
    return token;
  }
}

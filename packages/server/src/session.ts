import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { probe } from './imaging.js';
import {
  EXT,
  type AssetMeta,
  applyRdl,
  cloneDocument,
  createDocument,
  emptyReviews,
  mentions,
  reviewId,
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
import { loadDocument, saveDocument } from '@rangoli/engine/io';

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

  private constructor(readonly dir: string, readonly doc: RangoliDocument) {
    super();
    doc.onChange((entry) => {
      this.emit('change', entry);
      this.scheduleSave();
    });
  }

  private static async boot(dir: string, doc: RangoliDocument): Promise<Session> {
    const s = new Session(dir, doc);
    const file = join(dir, 'reviews.json');
    if (existsSync(file)) {
      const r = JSON.parse(await readFile(file, 'utf8')) as Partial<ReviewData> & { agentMode?: AgentMode };
      s.reviews = { ...emptyReviews(), ...r };
      if (r.agentMode === 'suggest') s.agentMode = 'suggest';
    }
    return s;
  }

  static async open(dir: string): Promise<Session> {
    const abs = resolve(dir);
    return Session.boot(abs, await loadDocument(abs));
  }

  static async create(dir: string, name: string, tokens: DefaultTokenOptions = {}): Promise<Session> {
    const abs = resolve(dir);
    if (existsSync(resolve(abs, 'manifest.json'))) throw new Error(`A Rangoli document already exists at ${abs}`);
    const doc = createDocument(name, tokens);
    await saveDocument(doc, abs);
    return Session.boot(abs, doc);
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
    this.saveTimer = setTimeout(() => void this.flush(), 150);
  }

  /** Persist now (waits for any in-flight save). */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saving = this.saving
      .then(async () => {
        await saveDocument(this.doc, this.dir);
        await writeFile(join(this.dir, 'reviews.json'), JSON.stringify({ ...this.reviews, agentMode: this.agentMode }, null, 2) + '\n');
      })
      .then(() => {
        this.emit('saved');
      });
    return this.saving;
  }

  private reviewsChanged() {
    this.emit('reviews');
    this.scheduleSave();
  }

  // ---------------------------------------------------------------- agent mode

  setAgentMode(mode: AgentMode): void {
    this.agentMode = mode;
    this.emit('mode', mode);
    this.scheduleSave();
  }

  // ---------------------------------------------------------------- comments & review pins

  addThread(input: { node: string | null; author: string; body: string; kind?: 'comment' | 'review'; severity?: Severity; fix?: string; title?: string }): Thread {
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

  /** Open threads that mention the agent and whose last word is not the agent's. */
  agentInbox(names = ['agent', 'claude', 'cursor', 'darshana']): Thread[] {
    return this.reviews.threads.filter((t) => {
      if (t.resolved) return false;
      const last = t.comments.at(-1);
      if (!last || last.author.startsWith('agent')) return false;
      return t.comments.some((c) => mentions(c.body).some((m) => names.includes(m)));
    });
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

  // ---------------------------------------------------------------- versions

  async saveVersion(name: string, author: string): Promise<VersionMeta> {
    const v: VersionMeta = { id: reviewId('v', this.reviews.versions), name, author, time: Date.now(), seq: this.doc.historyEntries.at(-1)?.seq ?? 0 };
    await mkdir(join(this.dir, 'versions'), { recursive: true });
    await writeFile(join(this.dir, 'versions', `${v.id}.json`), JSON.stringify(cloneDocument(this.doc).data) + '\n');
    this.reviews.versions.push(v);
    this.reviewsChanged();
    return v;
  }

  async loadVersion(id: string): Promise<DocumentData> {
    if (!/^v\d+$/.test(id)) throw new Error(`Bad version id ${id}`);
    const file = join(this.dir, 'versions', `${id}.json`);
    if (!existsSync(file)) throw new Error(`Version ${id} not found`);
    return JSON.parse(await readFile(file, 'utf8')) as DocumentData;
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

  assetPath(meta: AssetMeta): string {
    return join(this.dir, 'assets', meta.file);
  }

  /** Store bytes once (sha256), register metadata as an undoable change. */
  async addAsset(buf: Buffer, mime: string, name: string, extra: Partial<AssetMeta> & { source: AssetMeta['source'] }, author: string): Promise<AssetMeta> {
    const ext = EXT[mime];
    if (!ext) throw new Error(`Unsupported image type ${mime} (png, jpeg, webp, gif, svg, avif)`);
    if (buf.length > 15 * 1024 * 1024) throw new Error('Image larger than 15 MB');
    const id = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const existing = this.doc.data.assets?.[id];
    if (existing) return existing;
    const { w, h } = probe(buf, mime);
    await mkdir(join(this.dir, 'assets'), { recursive: true });
    const file = `${id}.${ext}`;
    if (!existsSync(join(this.dir, 'assets', file))) await writeFile(join(this.dir, 'assets', file), buf);
    const meta: AssetMeta = { id, name: name.slice(0, 80) || file, file, mime, w, h, bytes: buf.length, time: Date.now(), ...extra };
    this.doc.apply([{ op: 'setAsset', id, meta }], { author, label: `${extra.source} ${meta.name}` });
    return meta;
  }

  async readAsset(meta: AssetMeta): Promise<Buffer> {
    return readFile(this.assetPath(meta));
  }

  /** data: URI for screenshots/compose (headless pages cannot fetch local files). */
  assetDataUri = (meta: AssetMeta): string => {
    try {
      return `data:${meta.mime};base64,${readFileSync(this.assetPath(meta)).toString('base64')}`;
    } catch {
      return '';
    }
  };

  createShareToken(role: Exclude<Role, 'owner'>): string {
    const token = randomBytes(18).toString('base64url');
    this.shareTokens.set(token, role);
    return token;
  }
}

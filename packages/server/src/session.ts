import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDocument, loadDocument, saveDocument, type ChangeEntry, type DefaultTokenOptions, type RangoliDocument } from '@rangoli/engine';

export interface SessionEvents {
  change: [ChangeEntry];
  saved: [];
}

/**
 * One open document: load, autosave (debounced), broadcast changes to preview/editor clients.
 */
export class Session extends EventEmitter<SessionEvents> {
  private saveTimer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();
  selection: string[] = [];

  private constructor(readonly dir: string, readonly doc: RangoliDocument) {
    super();
    doc.onChange((entry) => {
      this.emit('change', entry);
      this.scheduleSave();
    });
  }

  static async open(dir: string): Promise<Session> {
    const abs = resolve(dir);
    return new Session(abs, await loadDocument(abs));
  }

  static async create(dir: string, name: string, tokens: DefaultTokenOptions = {}): Promise<Session> {
    const abs = resolve(dir);
    if (existsSync(resolve(abs, 'manifest.json'))) throw new Error(`A Rangoli document already exists at ${abs}`);
    const doc = createDocument(name, tokens);
    await saveDocument(doc, abs);
    return new Session(abs, doc);
  }

  static async openOrCreate(dir: string, name = 'Untitled'): Promise<Session> {
    return existsSync(resolve(dir, 'manifest.json')) ? Session.open(dir) : Session.create(dir, name);
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 150);
  }

  /** Persist now (waits for any in-flight save). */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saving = this.saving.then(() => saveDocument(this.doc, this.dir)).then(() => {
      this.emit('saved');
    });
    return this.saving;
  }
}

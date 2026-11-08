/** Short, stable, base36 IDs ("n1", "n2a"). Monotonic per document. */
export class IdGen {
  private next: number;
  constructor(private prefix = 'n', start = 1) {
    this.next = start;
  }
  /** Ensure future ids don't collide with existing ones. */
  observe(id: string): void {
    if (!id.startsWith(this.prefix)) return;
    const n = parseInt(id.slice(this.prefix.length), 36);
    if (Number.isFinite(n) && n >= this.next) this.next = n + 1;
  }
  make(): string {
    return this.prefix + (this.next++).toString(36);
  }
}

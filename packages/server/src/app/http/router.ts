/** A small typed router: method plus an anchored path pattern, first match wins. */
import type { Handler } from './context.js';

/** A path segment that must be a UUID; captured into Ctx.p. */
export const U = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

export class Router {
  private readonly routes: { method: string; re: RegExp; h: Handler }[] = [];

  on(method: string, path: string, h: Handler): void {
    this.routes.push({ method, re: new RegExp(`^${path}$`), h });
  }

  match(method: string | undefined, path: string): { h: Handler; p: string[] } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      return { h: r.h, p: m.slice(1) };
    }
    return null;
  }
}

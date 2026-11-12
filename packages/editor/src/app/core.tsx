import { useCallback, useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

// ---------------------------------------------------------------- api

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) {
    // pages that work signed out handle this themselves
    if (res.status === 401 && !path.startsWith('/api/auth') && !/^\/(login|signup|invite|forgot|reset)/.test(location.pathname)) navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
    throw new ApiError(res.status, data.error ?? 'That did not work. Try again.', data);
  }
  return data as T;
}
export const get = <T,>(p: string) => call<T>('GET', p);
export const post = <T,>(p: string, b?: unknown) => call<T>('POST', p, b);
export const patch = <T,>(p: string, b?: unknown) => call<T>('PATCH', p, b);
export const put = <T,>(p: string, b?: unknown) => call<T>('PUT', p, b);
export const del = <T,>(p: string) => call<T>('DELETE', p);

/** Load on mount and whenever deps change. reload() refetches without blanking what is on screen. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const latest = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    const n = ++latest.current;
    try {
      const d = await run();
      if (n === latest.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === latest.current) setError(e instanceof ApiError ? e : new ApiError(0, 'Could not reach the server.'));
    }
  }, [run]);
  useEffect(() => {
    setData(null);
    setError(null);
    void reload();
  }, [reload]);
  return { data, error, reload };
}

// ---------------------------------------------------------------- routing

const listeners = new Set<() => void>();
export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  listeners.forEach((l) => l());
}
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function usePath(): string {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const l = () => setPath(location.pathname + location.search);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return path;
}

export function Link({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------- shared ui

export function ErrorLine({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <p className="form-error" role="alert">{error}</p>;
}

export function Loading({ label }: { label: string }) {
  return <div className="page-state" role="status">{label}</div>;
}

export function Failed({ error, retry }: { error: ApiError; retry?: () => void }) {
  return (
    <div className="page-state">
      <h1 className="state-title">{error.status === 404 ? 'Nothing here' : 'That did not load'}</h1>
      <p>{error.status === 404 ? 'This page does not exist, or you do not have access to it.' : error.message}</p>
      {retry && error.status !== 404 && <button className="a-btn" onClick={retry}>Try again</button>}
      {error.status === 404 && <Link className="a-btn" href="/">Go to your projects</Link>}
    </div>
  );
}

/** Run an async action with a pending flag and an inline error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className="a-modal" aria-label={title} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="a-modal-body">
        <h2 className="a-h2">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="a-field">
      <span className="a-label">{label}</span>
      {children}
      {hint && <span className="a-hint">{hint}</span>}
    </label>
  );
}

export const ago = (iso: string): string => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};

/** An organization role (owner, admin, member, guest); for display. Decisions use `can`. */
export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
/** A project role (lead, designer, researcher, product_manager, developer, reviewer, viewer); for display. */
export type ProjectRole = string;
/** `can` lists the organization capabilities the server's has_capability gives this person. */
export interface OrgSummary { id: string; name: string; slug: string; role: OrgRole; can: string[] }
export interface Me { user: { id: string; name: string; email: string }; orgs: OrgSummary[] }

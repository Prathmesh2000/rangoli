/**
 * The public side of share links: /s/<token> for stakeholders and developers, with no session.
 *
 * A link opens one frozen snapshot, rendered statically with no scripts, and nothing else: not the working copy,
 * not the project. The token is 256 random bits and only its SHA-256 is stored; revoked or expired links answer
 * like unknown ones. Pages are noindex, send no Referer, and are rate limited per link. Approving is never done
 * here: the page links into the app, where the person signs in, has a verified email and steps up with MFA.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DocumentData, LifecycleItem, ScreenFrameLink } from '@rangoli/engine';
import { tokenHash } from '../auth.js';
import type { AppCore } from '../http/context.js';
import { buildHandoff } from '../projects/handoff.js';
import { renderStatic, sendStaticPage } from './render.js';
import { isShareToken } from './routes.js';
import type { Snapshots } from './snapshots.js';

interface OpenLink {
  link_id: string;
  kind: 'stakeholder' | 'developer';
  project_id: string;
  org_id: string;
  project_name: string;
  snapshot_id: string;
  snapshot_name: string;
  cycle: number;
  content_hash: string;
  library_hash: string;
  canon_version: string;
  engine_version: string;
  signature: string;
  signing_key: string;
  created_by_name: string;
  created_at: string | Date;
  expires_at: string | Date;
  data: DocumentData;
  items: LifecycleItem[];
  annotations: { n: number; node: string; body: string }[];
  frames: ScreenFrameLink[];
  approval_id: string | null;
  approval_status: string | null;
}

/** Requests per link per minute. One process serves the app, so an in-memory window is enough. */
const PER_MINUTE = 60;

const day = (d: string | Date) => new Date(d).toISOString().slice(0, 10);

export function createShareServer(core: AppCore, snapshots: Snapshots) {
  const windows = new Map<string, { start: number; n: number }>();
  const limited = (key: string) => {
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start > 60_000) {
      if (windows.size > 10_000) windows.clear();
      windows.set(key, { start: now, n: 1 });
      return false;
    }
    w.n += 1;
    return w.n > PER_MINUTE;
  };

  const gone = (res: ServerResponse, status = 404, text = 'This link has expired, was revoked, or never existed. Ask whoever shared it for a new one.') =>
    sendStaticPage(res, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>Link unavailable</title></head><body style="font:15px/1.5 system-ui,sans-serif;padding:48px"><h1 style="font-size:20px">Link unavailable</h1><p>${text}</p></body></html>`, { status });

  /** Handles /s/<token> and /s/<token>/handoff.json. Returns false when the path is not a share link. */
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const m = /^\/s\/([^/]+)(\/handoff\.json)?$/.exec(path);
    if (!m) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      gone(res, 405, 'Share links are view-only.');
      return true;
    }
    const token = m[1]!;
    if (!isShareToken(token)) {
      gone(res);
      return true;
    }
    const hash = tokenHash(token);
    if (limited(hash)) {
      gone(res, 429, 'Too many requests for this link. Wait a minute and try again.');
      return true;
    }
    const [link] = await core.as(null, (q) => q<OpenLink>(`SELECT * FROM share_link_open($1)`, [hash]));
    if (!link) {
      gone(res);
      return true;
    }
    const rows = await core.as(null, (q) => q<{ file: string; mime: string; storage: string; bytes: Uint8Array | null }>(`SELECT file, mime, storage, bytes FROM share_link_assets($1)`, [hash]));
    const approved = link.approval_status === 'approved';
    const snapshotRef = { id: link.snapshot_id, name: link.snapshot_name, contentHash: link.content_hash, libraryHash: link.library_hash, canonVersion: link.canon_version, engineVersion: link.engine_version, signature: link.signature, signingKey: link.signing_key, createdAt: new Date(link.created_at).toISOString(), createdBy: link.created_by_name };

    if (m[2]) {
      if (link.kind !== 'developer') {
        gone(res);
        return true;
      }
      const bundle = buildHandoff(
        { project: link.project_name, cycle: link.cycle, workType: '', data: link.data, items: link.items, frames: link.frames, annotations: link.annotations },
        approved ? { status: 'approved', snapshot: snapshotRef, approvedBy: [] } : { status: 'snapshot', snapshot: snapshotRef, approvedBy: [] },
      );
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow, noarchive',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': `attachment; filename="handoff-${link.content_hash.slice(0, 12)}.json"`,
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(bundle, null, 2));
      return true;
    }

    const assets = await snapshots.dataUris(rows, link.org_id, link.project_id);
    const status = approved ? 'Approved version' : link.approval_status === 'open' ? 'Waiting for approval' : link.approval_status === 'changes_requested' ? 'Changes were requested on this version' : 'Saved version, not approved';
    const action = link.kind === 'developer'
      ? { href: `/s/${token}/handoff.json`, text: 'Download the handoff bundle for this version' }
      : link.approval_id && link.approval_status === 'open'
        ? { href: `/p/${link.project_id}/review?approval=${link.approval_id}`, text: 'Approve this version (you will sign in and confirm it is you)' }
        : undefined;
    const html = renderStatic(link.data, {
      title: `${link.project_name} · ${link.snapshot_name}`,
      assets,
      heading: {
        project: link.project_name,
        label: link.snapshot_name,
        hash: link.content_hash,
        lines: [`${status}. Saved ${day(link.created_at)}${link.created_by_name ? ` by ${link.created_by_name}` : ''}. View only; this link expires ${day(link.expires_at)}.`],
        action,
      },
    });
    sendStaticPage(res, req.method === 'HEAD' ? '' : html);
    return true;
  };
}

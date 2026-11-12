/**
 * The page steps both adapters run. One copy, so local and hosted renders cannot drift apart.
 * Functions passed to evaluate run in the page and must stay self-contained.
 */
import { scene3dModule, type EditOp } from '@rangoli/engine';
import type { EditJob, EditResult, ShotJob } from './port.js';

export type Page = {
  setContent(html: string, o?: object): Promise<void>;
  evaluate<T, A>(fn: (a: A) => T, arg: A): Promise<T>;
  locator(sel: string): { screenshot(o?: object): Promise<Buffer> };
  close(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
};

/** Thrown when a job asks for more than the service allows. `status` is the HTTP answer. */
export class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const pageOptions = (job: ShotJob) => ({ viewport: job.viewport, deviceScaleFactor: job.scale });
export const EDIT_PAGE_OPTIONS = { viewport: { width: 800, height: 600 } };

const waitFor3d = (page: Page) =>
  // 3D scenes render asynchronously: wait until each has drawn (or give up after 15s and show its poster)
  page.evaluate((src: string) => new Promise<void>((done) => {
    const els = document.querySelectorAll('.rk-3d');
    if (!els.length) return done();
    const tag = document.createElement('script');
    tag.type = 'module';
    tag.textContent = src;
    document.head.appendChild(tag);
    const t0 = Date.now();
    const poll = () => {
      let ready = true;
      els.forEach((e) => { if (!e.hasAttribute('data-ready')) ready = false; });
      if (ready || Date.now() - t0 > 15000) done();
      else setTimeout(poll, 100);
    };
    poll();
  }), scene3dModule(false));

const fit = (page: Page, maxWidth: number) =>
  page.evaluate((m: number) => {
    const el = document.getElementById('shot')!;
    const w = el.scrollWidth;
    if (w > m) (el.style as CSSStyleDeclaration & { zoom: string }).zoom = String(m / w);
  }, maxWidth);

const decodeImages = (page: Page) =>
  page.evaluate(() => Promise.all(Array.from(document.querySelectorAll('img')).map((i) => i.decode().catch(() => undefined))), undefined);

const freezeFilmstrip = (page: Page, arg: { times: number[]; tracks: { id: string; at: number }[]; exit: boolean }) =>
  page.evaluate(
    (a: { times: number[]; tracks: { id: string; at: number }[]; exit: boolean }) => {
      // crop every frame to the animated elements (measured at rest, before freezing) + margin
      const first = document.querySelector<HTMLElement>('.cell .inner')!;
      const base = first.getBoundingClientRect();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const tr of a.tracks) {
        const el = first.querySelector<HTMLElement>(`[data-rid="${tr.id}"]`);
        if (!el) continue;
        el.style.animation = 'none';
        const r = el.getBoundingClientRect();
        el.style.animation = '';
        x0 = Math.min(x0, r.left - base.left); y0 = Math.min(y0, r.top - base.top);
        x1 = Math.max(x1, r.right - base.left); y1 = Math.max(y1, r.bottom - base.top);
      }
      if (Number.isFinite(x0)) {
        const pad = 32;
        const cx = Math.max(0, x0 - pad), cy = Math.max(0, y0 - pad);
        const w = Math.min(base.width - cx, x1 - x0 + pad * 2), h = Math.min(base.height - cy, y1 - y0 + pad * 2);
        document.querySelectorAll<HTMLElement>('.crop').forEach((c) => { c.style.width = `${w}px`; c.style.height = `${h}px`; });
        document.querySelectorAll<HTMLElement>('.inner').forEach((n) => { n.style.transform = `translate(${-cx}px, ${-cy}px)`; });
      }
      document.querySelectorAll<HTMLElement>('.cell').forEach((cell, i) => {
        const t = a.times[i]!;
        for (const tr of a.tracks) {
          const el = cell.querySelector<HTMLElement>(`[data-rid="${tr.id}"]`);
          if (!el) continue;
          if (a.exit) el.setAttribute('data-exiting', '');
          // freeze at time t: negative delay = already elapsed; keep the track's own offset
          el.style.animationDelay = `${tr.at - t}ms`;
          el.style.animationPlayState = 'paused';
        }
      });
      const strip = document.getElementById('strip')!;
      const w = strip.scrollWidth;
      if (w > 1600) (strip.style as CSSStyleDeclaration & { zoom: string }).zoom = String(1600 / w);
    },
    arg,
  );

export async function runShot(page: Page, job: ShotJob, limits: { maxPixels?: number } = {}): Promise<Buffer> {
  await page.setContent(job.html);
  if (job.scene3d) await waitFor3d(page);
  const step = job.prepare;
  if (step?.kind === 'fit') await fit(page, step.maxWidth);
  if (step?.kind === 'decodeImages') await decodeImages(page);
  if (step?.kind === 'filmstrip') {
    await freezeFilmstrip(page, step);
    await page.waitForTimeout(50);
  }
  if (limits.maxPixels) {
    const area = await page.evaluate((sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? r.width * r.height : 0;
    }, job.selector);
    if (area * job.scale * job.scale > limits.maxPixels) throw new Refused(413, `The rendered picture is larger than ${limits.maxPixels / 1e6} megapixels`);
  }
  const options: { animations?: 'disabled'; omitBackground?: boolean } = {};
  if (job.animations) options.animations = job.animations;
  if (job.omitBackground) options.omitBackground = true;
  return page.locator(job.selector).screenshot(options);
}

export async function runEdit(page: Page, job: EditJob): Promise<EditResult> {
  await page.setContent('<!doctype html><body></body>');
  const out = await page.evaluate(
    async (a: { uri: string; ops: EditOp[]; type: string; q: number }) => {
      const img = new Image();
      img.src = a.uri;
      await img.decode();
      let c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      const next = (w: number, h: number, draw: (x: CanvasRenderingContext2D, prev: HTMLCanvasElement) => void) => {
        const n = document.createElement('canvas');
        n.width = Math.max(1, Math.round(w));
        n.height = Math.max(1, Math.round(h));
        const x = n.getContext('2d')!;
        x.imageSmoothingQuality = 'high';
        draw(x, c);
        c = n;
      };
      for (const o of a.ops) {
        if (o.op === 'crop') next(o.w, o.h, (x, prev) => x.drawImage(prev, o.x, o.y, o.w, o.h, 0, 0, o.w, o.h));
        else if (o.op === 'resize') {
          const h = o.h ?? (o.w / c.width) * c.height;
          // step down by halves for clean downscaling
          while (c.width / 2 >= o.w * 1.01) next(c.width / 2, c.height / 2, (x, prev) => x.drawImage(prev, 0, 0, prev.width / 2, prev.height / 2));
          next(o.w, h, (x, prev) => x.drawImage(prev, 0, 0, o.w, h));
        } else if (o.op === 'rotate') {
          const swap = o.deg !== 180;
          next(swap ? c.height : c.width, swap ? c.width : c.height, (x, prev) => {
            x.translate(x.canvas.width / 2, x.canvas.height / 2);
            x.rotate((o.deg * Math.PI) / 180);
            x.drawImage(prev, -prev.width / 2, -prev.height / 2);
          });
        } else if (o.op === 'flip') next(c.width, c.height, (x, prev) => {
          if (o.axis === 'h') { x.translate(prev.width, 0); x.scale(-1, 1); } else { x.translate(0, prev.height); x.scale(1, -1); }
          x.drawImage(prev, 0, 0);
        });
        else if (o.op === 'adjust') next(c.width, c.height, (x, prev) => {
          x.filter = `brightness(${o.brightness ?? 1}) contrast(${o.contrast ?? 1}) saturate(${o.saturation ?? 1})`;
          x.drawImage(prev, 0, 0);
        });
      }
      if (a.type === 'image/jpeg') next(c.width, c.height, (x, prev) => { x.fillStyle = '#fff'; x.fillRect(0, 0, prev.width, prev.height); x.drawImage(prev, 0, 0); });
      return { uri: c.toDataURL(a.type, a.q / 100), w: c.width, h: c.height };
    },
    { uri: `data:${job.mime};base64,${job.image.toString('base64')}`, ops: job.ops, type: `image/${job.format}`, q: job.quality },
  );
  if (!out.uri.startsWith(`data:image/${job.format}`)) throw new Error(`This browser cannot encode ${job.format}`);
  return { buf: Buffer.from(out.uri.slice(out.uri.indexOf(',') + 1), 'base64'), w: out.w, h: out.h };
}

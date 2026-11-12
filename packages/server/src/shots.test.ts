import { applyRdl, createDocument } from '@rangoli/engine';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeShots, renderPng } from './shots.js';

const rendered = vi.hoisted(() => [] as string[]);

/** A browser that records each page's HTML, and yields between every step so concurrent renders interleave. */
vi.mock('playwright-core', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const page = {
    setContent: async (html: string) => {
      await tick();
      rendered.push(html);
    },
    evaluate: async () => undefined,
    locator: () => ({ screenshot: async () => Buffer.from('png') }),
    waitForTimeout: tick,
    close: async () => undefined,
  };
  const browser = {
    newPage: async () => {
      await tick();
      return page;
    },
    close: async () => undefined,
  };
  return { chromium: { launch: async () => browser } };
});

const docWithImage = () => {
  const doc = createDocument();
  doc.apply([{ op: 'setAsset', id: 'a1b2c3d4e5f6', meta: { id: 'a1b2c3d4e5f6', name: 'hero.png', file: 'a1b2c3d4e5f6.png', mime: 'image/png', w: 10, h: 10, bytes: 1, source: 'upload', time: 0 } }]);
  applyRdl(doc, 'Image asset:hero.png w10 h10');
  return doc;
};

describe('screenshots', () => {
  afterAll(closeShots);

  it('concurrent renders each use their own asset resolver', async () => {
    const tenants = ['TENANT-A', 'TENANT-B', 'TENANT-C', 'TENANT-D'];
    await Promise.all(tenants.map((t) => renderPng(docWithImage(), { assetUrl: () => `data:image/png;base64,${t}` })));
    expect(rendered).toHaveLength(tenants.length);
    for (const t of tenants) {
      const mine = rendered.filter((html) => html.includes(t));
      expect(mine, t).toHaveLength(1);
      for (const other of tenants.filter((x) => x !== t)) expect(mine[0], `${t} saw ${other}`).not.toContain(other);
    }
  });
});

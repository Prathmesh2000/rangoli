/** Upload limits, enforced before any image reaches a decoder. */
import { Refused } from './execute.js';
import { probe } from './probe.js';

export const MAX_PIXELS = 40_000_000;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const startsWith = (buf: Buffer, bytes: number[], at = 0) => bytes.every((b, i) => buf[at + i] === b);

/** The image type the bytes themselves claim to be, ignoring any label. */
export function sniffMime(buf: Buffer): string | undefined {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brands = buf.toString('latin1', 8, Math.min(buf.length, 8 + Math.max(0, buf.readUInt32BE(0) - 8)));
    for (let i = 0; i + 4 <= brands.length; i += 4) {
      const brand = brands.slice(i, i + 4);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
    return undefined;
  }
  if (svgRoot(buf)) return 'image/svg+xml';
  return undefined;
}

/** The root tag of an SVG, after any BOM, XML prolog, doctype or comments. */
function svgRoot(buf: Buffer): string | undefined {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 16_384)).replace(/^﻿/, '');
  const rest = head.replace(/^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)*/i, '');
  return /^<svg\b[^>]*>/i.exec(rest)?.[0];
}

/** Refuses anything whose bytes do not match its label, or that would decode past the limits. Returns its size. */
export function checkImage(buf: Buffer, mime: string): { w: number; h: number } {
  if (buf.length > MAX_IMAGE_BYTES) throw new Refused(413, `Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const actual = sniffMime(buf);
  if (actual !== mime) throw new Refused(415, `Image content does not match its type: labelled ${mime}, looks like ${actual ?? 'something else'}`);
  let size: { w: number; h: number };
  try {
    // only the root tag counts for SVG, so a nested element cannot pose as the size of the drawing
    size = probe(mime === 'image/svg+xml' ? Buffer.from(svgRoot(buf)!) : buf, mime);
  } catch {
    throw new Refused(415, `Cannot read the dimensions of this ${mime} file`);
  }
  if (!(size.w > 0 && size.h > 0)) throw new Refused(415, `This ${mime} file reports no dimensions`);
  if (size.w * size.h > MAX_PIXELS) throw new Refused(413, `Image is ${((size.w * size.h) / 1e6).toFixed(1)} megapixels; the limit is ${MAX_PIXELS / 1e6}`);
  return size;
}

const INLINE_IMAGE = /data:(image\/[a-z0-9.+-]+)(?:;[a-z0-9=_.-]+)*;base64,([a-z0-9+/]+={0,2})/gi;

/**
 * Chromium never shows data: URLs to request interception, so inline images are checked in the markup.
 * This reads literal URLs. One hidden behind HTML or CSS escapes is contained by the timeout and browser restart instead.
 */
export function checkInlineImages(html: string): void {
  for (const m of html.matchAll(INLINE_IMAGE)) checkImage(Buffer.from(m[2]!, 'base64'), m[1]!.toLowerCase());
}

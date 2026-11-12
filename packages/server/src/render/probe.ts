/**
 * Image dimensions from file headers only: nothing here decodes pixels, so it is safe on untrusted bytes.
 * Shared by the app and the render service, and free of browser or database imports.
 */

type Box = [type: string, start: number, end: number];

/** The boxes in an ISO-BMFF byte range, as payload ranges. Stops at the first box that does not fit. */
function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  for (let i = from; i + 8 <= to;) {
    let size = buf.readUInt32BE(i), head = 8;
    if (size === 1) {
      if (i + 16 > to) break;
      const large = buf.readBigUInt64BE(i + 8);
      if (large > BigInt(to - i)) break;
      size = Number(large);
      head = 16;
    } else if (size === 0) size = to - i; // runs to the end
    if (size < head || i + size > to) break;
    out.push([buf.toString('latin1', i + 4, i + 8), i + head, i + size]);
    i += size;
  }
  return out;
}

/** Property indexes (1-based) that ipma boxes associate with one item. */
function itemProps(buf: Buffer, ipma: Box[], item: number): number[] {
  const out: number[] = [];
  for (const [, start, end] of ipma) {
    if (start + 8 > end) continue;
    const wideId = buf[start]! >= 1, wideProp = (buf[start + 3]! & 1) === 1, idSize = wideId ? 4 : 2, propSize = wideProp ? 2 : 1;
    let at = start + 8;
    for (let n = buf.readUInt32BE(start + 4); n > 0 && at + idSize + 1 <= end; n--) {
      const id = wideId ? buf.readUInt32BE(at) : buf.readUInt16BE(at);
      const count = buf[at + idSize]!;
      at += idSize + 1;
      if (at + count * propSize > end) return out;
      if (id === item) for (let k = 0; k < count; k++) out.push(wideProp ? buf.readUInt16BE(at + k * 2) & 0x7fff : buf[at + k]! & 0x7f);
      at += count * propSize;
    }
  }
  return out;
}

/** Displayed size of an AVIF: the primary item's ispe (with its rotation), or the largest ispe if the file names no primary. */
function avifSize(buf: Buffer): { w: number; h: number } | undefined {
  const top = boxes(buf, 0, buf.length);
  const ftyp = top[0]?.[0] === 'ftyp' && top[0][2] - top[0][1] >= 8 ? top[0] : undefined;
  if (!ftyp) return undefined;
  const brands = [ftyp[1], ...Array.from({ length: (ftyp[2] - ftyp[1] - 8) >> 2 }, (_, i) => ftyp[1] + 8 + i * 4)].map((at) => buf.toString('latin1', at, at + 4));
  if (!brands.includes('avif') && !brands.includes('avis')) return undefined;
  const meta = top.find((b) => b[0] === 'meta');
  if (!meta) return undefined;
  const inMeta = boxes(buf, meta[1] + 4, meta[2]);
  const iprp = inMeta.find((b) => b[0] === 'iprp');
  if (!iprp) return undefined;
  const inIprp = boxes(buf, iprp[1], iprp[2]);
  const ipco = inIprp.find((b) => b[0] === 'ipco');
  if (!ipco) return undefined;
  const props = boxes(buf, ipco[1], ipco[2]);
  const ispe = (b: Box | undefined) => (b?.[0] === 'ispe' && b[2] - b[1] >= 12 ? { w: buf.readUInt32BE(b[1] + 4), h: buf.readUInt32BE(b[1] + 8) } : undefined);
  let size: { w: number; h: number } | undefined;
  const pitm = inMeta.find((b) => b[0] === 'pitm');
  if (pitm) {
    const wide = buf[pitm[1]]! >= 1;
    if (pitm[1] + (wide ? 8 : 6) <= pitm[2]) {
      const own = itemProps(buf, inIprp.filter((b) => b[0] === 'ipma'), wide ? buf.readUInt32BE(pitm[1] + 4) : buf.readUInt16BE(pitm[1] + 4)).map((i) => props[i - 1]);
      size = own.map(ispe).find(Boolean);
      const irot = own.find((b) => b?.[0] === 'irot');
      if (size && irot && irot[1] < irot[2] && buf[irot[1]]! & 1) size = { w: size.h, h: size.w };
    }
  }
  size ??= props.map(ispe).reduce((a, b) => (b && (!a || b.w * b.h > a.w * a.h) ? b : a), undefined);
  return size && size.w > 0 && size.h > 0 ? size : undefined;
}

/** Width/height from file headers (PNG, JPEG, WebP, GIF, SVG, AVIF). */
export function probe(buf: Buffer, mime: string): { w: number; h: number } {
  if (mime === 'image/png' && buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (mime === 'image/gif' && buf.length > 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  if (mime === 'image/svg+xml') {
    const s = buf.toString('utf8', 0, Math.min(buf.length, 4000));
    const w = /(?<![-\w])width="(\d+(?:\.\d+)?)/.exec(s)?.[1], h = /(?<![-\w])height="(\d+(?:\.\d+)?)/.exec(s)?.[1];
    if (w && h) return { w: Math.round(+w), h: Math.round(+h) };
    const vb = /viewBox="[\d.\s-]*?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/.exec(s);
    if (vb) return { w: Math.round(+vb[1]!), h: Math.round(+vb[2]!) };
  }
  if (mime === 'image/avif') {
    const size = avifSize(buf);
    if (size) return size;
  }
  throw new Error(`Cannot read dimensions of this ${mime} file`);
}

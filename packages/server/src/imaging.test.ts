import { describe, expect, it } from 'vitest';
import { probe } from './imaging.js';

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type: string, ...body: Buffer[]) => { const data = Buffer.concat(body); return Buffer.concat([u32(data.length + 8), Buffer.from(type, 'latin1'), data]); };
const full = (type: string, ...body: Buffer[]) => box(type, u32(0), ...body);
const ftyp = (...brands: string[]) => box('ftyp', Buffer.from(brands[0]!, 'latin1'), u32(0), ...brands.slice(1).map((b) => Buffer.from(b, 'latin1')));
const ispe = (w: number, h: number) => full('ispe', u32(w), u32(h));
const avif = (...parts: Buffer[]) => Buffer.concat([ftyp('avif', 'mif1', 'miaf'), ...parts]);
const iprp = (...children: Buffer[]) => box('iprp', ...children);
const meta = (...children: Buffer[]) => full('meta', ...children);
const AVIF = 'image/avif';
const unreadable = /Cannot read dimensions/;

describe('probe: AVIF', () => {
  it('reads the size from the only ispe box', () => {
    expect(probe(avif(meta(iprp(box('ipco', ispe(640, 480))))), AVIF)).toEqual({ w: 640, h: 480 });
  });

  it('accepts avis as a compatible brand and avif as the major brand', () => {
    const body = meta(iprp(box('ipco', ispe(10, 20))));
    expect(probe(Buffer.concat([ftyp('mif1', 'avis'), body]), AVIF)).toEqual({ w: 10, h: 20 });
    expect(probe(Buffer.concat([ftyp('avif'), body]), AVIF)).toEqual({ w: 10, h: 20 });
  });

  it('uses the primary item, not a larger item or the first ispe', () => {
    // item 2 is primary and owns property 2; item 1 (a bigger image) owns property 1
    const ipma = full('ipma', u32(2), u16(1), Buffer.from([1, 1]), u16(2), Buffer.from([1, 0x82]));
    const file = avif(meta(full('pitm', u16(2)), iprp(box('ipco', ispe(4000, 3000), ispe(1200, 800)), ipma)));
    expect(probe(file, AVIF)).toEqual({ w: 1200, h: 800 });
  });

  it('reads version 1 pitm and ipma with wide property indexes', () => {
    const ipma = box('ipma', Buffer.from([1, 0, 0, 1]), u32(1), u32(7), Buffer.from([1]), u16(0x8002));
    const pitm = box('pitm', Buffer.from([1, 0, 0, 0]), u32(7));
    expect(probe(avif(meta(pitm, iprp(box('ipco', ispe(9, 9), ispe(30, 40)), ipma))), AVIF)).toEqual({ w: 30, h: 40 });
  });

  it('swaps width and height when the primary item is rotated a quarter turn', () => {
    const ipma = full('ipma', u32(1), u16(1), Buffer.from([2, 1, 2]));
    const rotated = (angle: number) => avif(meta(full('pitm', u16(1)), iprp(box('ipco', ispe(300, 100), box('irot', Buffer.from([angle]))), ipma)));
    expect(probe(rotated(1), AVIF)).toEqual({ w: 100, h: 300 });
    expect(probe(rotated(2), AVIF)).toEqual({ w: 300, h: 100 });
    expect(probe(rotated(3), AVIF)).toEqual({ w: 100, h: 300 });
  });

  it('falls back to the largest ispe when no primary item is named', () => {
    expect(probe(avif(meta(iprp(box('ipco', ispe(64, 64), ispe(2048, 1024), ispe(512, 512))))), AVIF)).toEqual({ w: 2048, h: 1024 });
  });

  it('reads 64-bit box sizes and a last box that runs to the end of the file', () => {
    const inner = iprp(box('ipco', ispe(50, 60)));
    const body = Buffer.concat([u32(0), inner]);
    const large = Buffer.alloc(8);
    large.writeBigUInt64BE(BigInt(body.length + 16));
    const wideMeta = Buffer.concat([u32(1), Buffer.from('meta'), large, body]);
    expect(probe(avif(wideMeta), AVIF)).toEqual({ w: 50, h: 60 });
    const toEnd = Buffer.concat([u32(0), Buffer.from('meta'), body]);
    expect(probe(avif(toEnd), AVIF)).toEqual({ w: 50, h: 60 });
  });

  it('skips unrelated boxes and finds meta after them', () => {
    expect(probe(avif(box('free', Buffer.alloc(32)), meta(box('hdlr', Buffer.alloc(24)), iprp(box('colr', Buffer.alloc(4)), box('ipco', box('pixi', Buffer.alloc(4)), ispe(7, 8))))), AVIF)).toEqual({ w: 7, h: 8 });
  });

  it('rejects files that are not AVIF', () => {
    const body = meta(iprp(box('ipco', ispe(10, 10))));
    expect(() => probe(Buffer.concat([ftyp('heic', 'mif1'), body]), AVIF)).toThrow(unreadable);
    expect(() => probe(body, AVIF)).toThrow(unreadable);
    expect(() => probe(Buffer.alloc(0), AVIF)).toThrow(unreadable);
    expect(() => probe(Buffer.from('not an image at all'), AVIF)).toThrow(unreadable);
  });

  it('rejects zero sizes and an ispe too short to hold a size', () => {
    expect(() => probe(avif(meta(iprp(box('ipco', ispe(0, 480))))), AVIF)).toThrow(unreadable);
    expect(() => probe(avif(meta(iprp(box('ipco', full('ispe', u32(640)))))), AVIF)).toThrow(unreadable);
  });

  it('survives boxes that lie about their size', () => {
    const lying = (size: number, type = 'meta') => Buffer.concat([u32(size), Buffer.from(type), Buffer.alloc(16)]);
    expect(() => probe(avif(lying(0xffffffff)), AVIF)).toThrow(unreadable); // past the end
    expect(() => probe(avif(lying(4)), AVIF)).toThrow(unreadable); // smaller than its own header: must not spin
    expect(() => probe(avif(lying(1)), AVIF)).toThrow(unreadable); // 64-bit size of zero
    const huge = Buffer.alloc(8, 0xff);
    expect(() => probe(avif(Buffer.concat([u32(1), Buffer.from('meta'), huge])), AVIF)).toThrow(unreadable);
  });

  it('survives every truncation of a valid file', () => {
    const ipma = full('ipma', u32(1), u16(1), Buffer.from([1, 1]));
    const file = avif(meta(full('pitm', u16(1)), iprp(box('ipco', ispe(640, 480)), ipma)));
    expect(probe(file, AVIF)).toEqual({ w: 640, h: 480 });
    for (let n = 0; n < file.length; n++) expect(() => probe(file.subarray(0, n), AVIF)).toThrow(unreadable);
  });

  it('survives ipma and pitm that overrun their boxes, using the largest ispe instead', () => {
    const props = box('ipco', ispe(640, 480));
    const hugeCount = full('ipma', u32(0xffffffff), u16(1), Buffer.from([200, 1]));
    expect(probe(avif(meta(full('pitm', u16(1)), iprp(props, hugeCount))), AVIF)).toEqual({ w: 640, h: 480 });
    const shortPitm = box('pitm', Buffer.from([0, 0, 0, 0]));
    expect(probe(avif(meta(shortPitm, iprp(props))), AVIF)).toEqual({ w: 640, h: 480 });
    const badIndex = full('ipma', u32(1), u16(1), Buffer.from([1, 99]));
    expect(probe(avif(meta(full('pitm', u16(1)), iprp(props, badIndex))), AVIF)).toEqual({ w: 640, h: 480 });
  });

  it('leaves the other formats alone', () => {
    const png = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png);
    png.writeUInt32BE(12, 16);
    png.writeUInt32BE(34, 20);
    expect(probe(png, 'image/png')).toEqual({ w: 12, h: 34 });
    expect(() => probe(png, 'image/tiff')).toThrow(unreadable);
  });
});

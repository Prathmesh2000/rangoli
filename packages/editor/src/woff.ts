import ttf2woff from 'ttf2woff';

/** The Buffer methods ttf2woff calls, which browsers do not have. */
class Bytes extends Uint8Array {
  private get view() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
  readUint16BE(at: number) { return this.view.getUint16(at); }
  readUint32BE(at: number) { return this.view.getUint32(at); }
  writeUint16BE(value: number, at: number) { this.view.setUint16(at, value); }
  writeUint32BE(value: number, at: number) { this.view.setUint32(at, value); }
}
const shim = { from: (b: ArrayBuffer, at: number, len: number) => new Bytes(b, at, len), alloc: (n: number) => new Bytes(n) };

/** Import this module lazily. ttf2woff expects a global Buffer, so one exists only while it runs. */
export function toWoff(ttf: Uint8Array): Uint8Array<ArrayBuffer> {
  const g = globalThis as { Buffer?: unknown };
  const had = g.Buffer;
  g.Buffer = shim;
  try { return ttf2woff(ttf); } finally { g.Buffer = had; }
}

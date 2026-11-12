/**
 * The Renderer port: everything Rangoli asks a headless browser to do, as plain serializable jobs.
 * Jobs name their page steps instead of carrying code, so the render service never runs a function it was sent.
 */
import type { EditOp, ImageFormat } from '@rangoli/engine';

export const SHOT_SELECTORS = ['#shot', '#sheet', '#strip', '#c > *'] as const;

/** What to do to the page between loading it and taking the picture. */
export type PrepareStep =
  | { kind: 'fit'; maxWidth: number }
  | { kind: 'decodeImages' }
  | { kind: 'filmstrip'; times: number[]; tracks: { id: string; at: number }[]; exit: boolean };

export interface ShotJob {
  html: string;
  viewport: { width: number; height: number };
  scale: number;
  selector: (typeof SHOT_SELECTORS)[number];
  animations?: 'disabled';
  omitBackground?: boolean;
  /** The page contains 3D scenes, the only case where page JavaScript may run. */
  scene3d?: boolean;
  prepare?: PrepareStep;
}

export interface EditJob {
  image: Buffer;
  mime: string;
  ops: EditOp[];
  format: ImageFormat;
  quality: number;
}

export interface EditResult {
  buf: Buffer;
  w: number;
  h: number;
}

export interface Renderer {
  /** A PNG of one element of an HTML page. */
  shot(job: ShotJob): Promise<Buffer>;
  /** Decode an image, apply canvas edits and encode the result. */
  edit(job: EditJob): Promise<EditResult>;
  close(): Promise<void>;
}

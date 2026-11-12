import type { ExportOptions, ExportPhase, ExportSelection } from './host.js';
import type { FigmaExport } from './schema.js';

export interface PageSummary {
  id: string;
  name: string;
}

export interface FrameSummary {
  id: string;
  name: string;
  type: string;
}

export type UiToMain =
  | { type: 'list-frames'; pageId: string }
  | { type: 'export'; selection: ExportSelection; options: ExportOptions }
  | { type: 'cancel' }
  | { type: 'close' };

export type MainToUi =
  | { type: 'init'; fileName: string; pages: PageSummary[]; currentPageId: string | null }
  | { type: 'frames'; pageId: string; frames: FrameSummary[]; total: number }
  | { type: 'frames-error'; pageId: string; message: string }
  | { type: 'progress'; phase: ExportPhase; done: number; total: number | null }
  | { type: 'export-result'; data: FigmaExport }
  | { type: 'export-error'; message: string }
  | { type: 'export-cancelled' };

/** Frames listed per page. Choosing the whole page still exports every layer. */
export const MAX_LISTED_FRAMES = 1_000;

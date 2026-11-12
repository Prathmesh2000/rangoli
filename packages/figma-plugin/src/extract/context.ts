import { ID_PATTERN, LIMITS, TOKEN_PATTERN } from '../limits.js';
import type { ExportGap, ExportNode } from '../schema.js';
import type { NodeLike } from '../host.js';

export type Severity = ExportGap['severity'];
export interface GapLocation {
  nodeId?: string;
  pageId?: string;
  field?: string;
}

/** Mutable state for one export run. */
export class ExtractContext {
  readonly nodes: ExportNode[] = [];
  readonly walked = new Set<string>();
  readonly gaps: ExportGap[] = [];
  readonly gapCounts = new Map<string, { severity: Severity; count: number }>();

  readonly imageHashes = new Set<string>();
  readonly variableIds = new Set<string>();
  readonly styleIds = new Set<string>();
  readonly fonts = new Map<string, { family: string; style: string }>();
  /** Component nodes seen as tree members or referenced by instances. */
  readonly componentNodes = new Map<string, NodeLike>();

  complete = true;

  gap(code: string, severity: Severity, message: string, loc: GapLocation = {}): void {
    const entry = this.gapCounts.get(code);
    if (entry) {
      entry.count += 1;
      if (rank(severity) > rank(entry.severity)) entry.severity = severity;
    } else if (this.gapCounts.size < LIMITS.maxGapCodes) {
      this.gapCounts.set(code, { severity, count: 1 });
    }
    if (this.gaps.length >= LIMITS.maxGaps) return;

    const gap: ExportGap = {
      code,
      severity,
      message: message.slice(0, LIMITS.maxGapMessageLength),
    };
    if (loc.nodeId !== undefined && isId(loc.nodeId)) gap.nodeId = loc.nodeId;
    if (loc.pageId !== undefined && isId(loc.pageId)) gap.pageId = loc.pageId;
    if (loc.field !== undefined) gap.field = loc.field.slice(0, LIMITS.maxNameLength);
    this.gaps.push(gap);
  }

  /** Reads a property that may throw on some node types. */
  read(node: Record<string, unknown>, key: string, nodeId?: string): unknown {
    try {
      return node[key];
    } catch (error) {
      this.gap('read-failed', 'warning', `Could not read ${key}: ${describe(error)}`, {
        ...(nodeId !== undefined && { nodeId }),
        field: key,
      });
      return undefined;
    }
  }

  /** Truncates an array to its cap, recording what was dropped. */
  cap<T>(items: readonly T[], max: number, code: string, what: string, nodeId?: string): readonly T[] {
    if (items.length <= max) return items;
    this.gap(code, 'warning', `${what}: kept ${max} of ${items.length}.`, {
      ...(nodeId !== undefined && { nodeId }),
    });
    return items.slice(0, max);
  }

  name(value: unknown, nodeId?: string): string {
    const text = typeof value === 'string' ? value : '';
    if (text.length <= LIMITS.maxNameLength) return text;
    this.gap('name-truncated', 'info', `Name cut to ${LIMITS.maxNameLength} characters.`, {
      ...(nodeId !== undefined && { nodeId }),
    });
    return text.slice(0, LIMITS.maxNameLength);
  }

  description(value: unknown, nodeId?: string): string | undefined {
    if (typeof value !== 'string' || value === '') return undefined;
    if (value.length <= LIMITS.maxDescriptionLength) return value;
    this.gap('description-truncated', 'info', 'Description cut to the size limit.', {
      ...(nodeId !== undefined && { nodeId }),
    });
    return value.slice(0, LIMITS.maxDescriptionLength);
  }

  noteFont(family: unknown, style: unknown): void {
    if (typeof family !== 'string' || typeof style !== 'string') return;
    const key = `${family}\u0000${style}`;
    if (this.fonts.has(key)) return;
    if (this.fonts.size >= LIMITS.maxFonts) {
      this.gap('font-list-truncated', 'info', 'Too many fonts to list them all.');
      return;
    }
    this.fonts.set(key, {
      family: family.slice(0, LIMITS.maxNameLength),
      style: style.slice(0, LIMITS.maxNameLength),
    });
  }
}

function rank(severity: Severity): number {
  return severity === 'error' ? 2 : severity === 'warning' ? 1 : 0;
}

export function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.maxIdLength &&
    ID_PATTERN.test(value)
  );
}

export function isToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.maxTokenLength &&
    TOKEN_PATTERN.test(value)
  );
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function shortKey(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, LIMITS.maxIdLength) : '';
}

type Kind = 'number' | 'token' | 'bool' | 'id';

/**
 * Copies scalar fields, leaving out absent and null values. `figma.mixed` is a
 * symbol; it lands in `mixed` so the consumer knows to read the detailed form.
 */
export function pick(
  ctx: ExtractContext,
  node: Record<string, unknown>,
  out: Record<string, unknown>,
  keys: readonly string[],
  kind: Kind,
  mixed: string[],
  nodeId?: string,
): void {
  for (const key of keys) {
    const value = ctx.read(node, key, nodeId);
    if (value === undefined || value === null) continue;
    if (typeof value === 'symbol') {
      mixed.push(key);
      continue;
    }
    if (kind === 'id' && value === '') continue;
    const valid =
      kind === 'number'
        ? isFiniteNumber(value)
        : kind === 'token'
          ? isToken(value)
          : kind === 'bool'
            ? typeof value === 'boolean'
            : isId(value);
    if (valid) {
      out[key] = value;
    } else {
      ctx.gap('unexpected-value', 'warning', `Unexpected value for ${key}; left out.`, {
        ...(nodeId !== undefined && { nodeId }),
        field: key,
      });
    }
  }
}

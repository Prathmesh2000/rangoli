import type { ItemKind } from '@rangoli/engine';
import { z } from 'zod';

const text = (max = 4000) => z.string().trim().max(max);
const id = z.string().uuid();
const ids = z.array(id).max(200);
const stateValue = z.enum(['done', 'na']).nullable();

/** Shape of `data` per kind. Strict, so a stray field is an error rather than silently stored. */
const DATA: Record<ItemKind, z.ZodObject> = {
  brief: z.strictObject({ users: text().optional(), goals: text().optional(), constraints: text().optional() }),
  research: z.strictObject({ method: z.enum(['interview', 'competitor', 'analytics', 'stakeholder', 'feedback', 'other']), insight: text().optional(), source: text(300).optional(), fromFeedback: id.optional() }),
  problem: z.strictObject({}),
  persona: z.strictObject({ role: text(120).optional(), goals: text().optional(), frustrations: text().optional(), evidence: ids.optional() }),
  story: z.strictObject({ persona: id.nullable().optional(), want: text(500).optional(), soThat: text(500).optional() }),
  screen: z.strictObject({
    stories: ids.optional(),
    frame: text(40).nullable().optional(),
    spec: text(8000).optional(),
    states: z.strictObject({ default: stateValue.optional(), hover: stateValue.optional(), focus: stateValue.optional(), disabled: stateValue.optional(), loading: stateValue.optional(), empty: stateValue.optional(), error: stateValue.optional() }).optional(),
  }),
  flow: z.strictObject({ steps: ids.optional(), story: id.nullable().optional() }),
  test_task: z.strictObject({ story: id.nullable().optional(), success: text(1000).optional() }),
  test_session: z.strictObject({
    date: text(40).optional(),
    results: z.array(z.strictObject({ task: id, outcome: z.enum(['pass', 'struggled', 'fail']), note: text(1000).optional() })).max(100).optional(),
  }),
  finding: z.strictObject({ severity: z.enum(['P0', 'P1', 'P2', 'P3']), screen: id.nullable().optional(), session: id.nullable().optional(), thread: text(20).optional() }),
  metric: z.strictObject({ target: text(120).optional(), actual: text(120).optional(), unit: text(40).optional() }),
  feedback: z.strictObject({ source: text(120).optional() }),
};

const STATUS: Partial<Record<ItemKind, string[]>> = {
  finding: ['open', 'fix', 'fixed', 'wontfix'],
  feedback: ['open', 'promoted', 'dismissed'],
};

export const ITEM_KINDS = Object.keys(DATA) as ItemKind[];

export function validateData(kind: ItemKind, data: unknown): Record<string, unknown> {
  return DATA[kind].parse(data ?? {}) as Record<string, unknown>;
}

export function validateStatus(kind: ItemKind, status: unknown): string {
  const allowed = STATUS[kind] ?? ['open'];
  if (typeof status !== 'string' || !allowed.includes(status)) throw new z.ZodError([{ code: 'custom', path: ['status'], message: `Status must be one of: ${allowed.join(', ')}`, input: status }]);
  return status;
}

/** Items this item points at, with the kind each must be. Checked so references stay inside the project. */
export function references(kind: ItemKind, data: Record<string, unknown>): { id: string; kind: ItemKind }[] {
  const out: { id: string; kind: ItemKind }[] = [];
  const add = (v: unknown, k: ItemKind) => {
    if (typeof v === 'string') out.push({ id: v, kind: k });
    else if (Array.isArray(v)) for (const x of v) out.push({ id: x as string, kind: k });
  };
  if (kind === 'persona') add(data.evidence, 'research');
  if (kind === 'story') add(data.persona, 'persona');
  if (kind === 'screen') add(data.stories, 'story');
  if (kind === 'flow') { add(data.steps, 'screen'); add(data.story, 'story'); }
  if (kind === 'test_task') add(data.story, 'story');
  if (kind === 'test_session') add(((data.results as { task: string }[] | undefined) ?? []).map((r) => r.task), 'test_task');
  if (kind === 'finding') { add(data.screen, 'screen'); add(data.session, 'test_session'); }
  return out;
}

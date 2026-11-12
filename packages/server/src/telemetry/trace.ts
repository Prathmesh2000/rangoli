/**
 * The seam for distributed tracing. Nothing here depends on OpenTelemetry: when it is added,
 * implement Tracer with it and call setTracer once at startup. Until then spans cost one function call.
 */
export type SpanAttributes = Record<string, string | number | boolean>;

export interface Tracer {
  span<T>(name: string, attributes: SpanAttributes, fn: () => T): T;
}

const NOOP: Tracer = { span: (_name, _attributes, fn) => fn() };

let current: Tracer = NOOP;

export const tracer = (): Tracer => current;

export function setTracer(next: Tracer | null): void {
  current = next ?? NOOP;
}

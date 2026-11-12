/**
 * A deliberately small metrics interface. The in-process implementation reports through the log;
 * an exporter (CloudWatch, OpenTelemetry) can implement the same three methods later.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger, type Logger } from './log.js';

export interface Metrics {
  increment(name: string, by?: number): void;
  gauge(name: string, value: number): void;
  /** One sample of something with a distribution, such as a wait in milliseconds. */
  observe(name: string, value: number): void;
}

export interface Distribution {
  count: number;
  sum: number;
  max: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  distributions: Record<string, Distribution>;
}

export class InMemoryMetrics implements Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private distributions = new Map<string, Distribution>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    const d = this.distributions.get(name) ?? { count: 0, sum: 0, max: 0 };
    d.count += 1;
    d.sum += value;
    d.max = Math.max(d.max, value);
    this.distributions.set(name, d);
  }

  /** With reset, counters and distributions start a new window; gauges keep their last value. */
  snapshot(opts: { reset?: boolean } = {}): MetricsSnapshot {
    const out: MetricsSnapshot = {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      distributions: Object.fromEntries([...this.distributions].map(([k, d]) => [k, { ...d }])),
    };
    if (opts.reset) {
      this.counters.clear();
      this.distributions.clear();
    }
    return out;
  }
}

export const metrics = new InMemoryMetrics();

const round = (n: number) => Math.round(n * 100) / 100;

export interface RuntimeMetricsOptions {
  metrics?: InMemoryMetrics;
  log?: Logger;
  intervalMs?: number;
}

/** Records event-loop lag and heap, and logs the window (including pool wait) periodically. Returns a stop function. */
export function startRuntimeMetrics(opts: RuntimeMetricsOptions = {}): () => void {
  const target = opts.metrics ?? metrics;
  const log = opts.log ?? logger;
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const timer = setInterval(() => {
    // the histogram reports nanoseconds and includes the sampling resolution itself
    if (lag.count > 0) {
      target.gauge('runtime.event_loop_lag_mean_ms', round(Math.max(0, lag.mean / 1e6 - 20)));
      target.gauge('runtime.event_loop_lag_p99_ms', round(Math.max(0, lag.percentile(99) / 1e6 - 20)));
      target.gauge('runtime.event_loop_lag_max_ms', round(Math.max(0, lag.max / 1e6 - 20)));
    }
    lag.reset();
    const memory = process.memoryUsage();
    target.gauge('runtime.heap_used_bytes', memory.heapUsed);
    target.gauge('runtime.heap_total_bytes', memory.heapTotal);
    target.gauge('runtime.rss_bytes', memory.rss);
    log.info('metrics', { metrics: target.snapshot({ reset: true }) });
  }, opts.intervalMs ?? 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    lag.disable();
  };
}

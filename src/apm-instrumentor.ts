import { IdGenerators } from "./id-generator.js";
// ─── Types ────────────────────────────────────────────────────────────────────

export interface TraceSpan {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  operation: string;
  duration: number; // milliseconds
  startTime: string;
  endTime: string;
  status: "success" | "error" | "pending";
  tags: Record<string, unknown>;
  logs: Array<{ timestamp: string; message: string }>;
}

export interface Trace {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  duration: number;
  spans: TraceSpan[];
  status: "success" | "error" | "pending";
}

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: string;
  timestamp: string;
}

export interface ServiceMetrics {
  serviceName: string;
  requestCount: number;
  errorCount: number;
  averageResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  throughput: number; // requests per second
}

// ─── APMInstrumentor ──────────────────────────────────────────────────────────

export class APMInstrumentor {
  private traces: Map<string, Trace> = new Map();
  private spans: Map<string, TraceSpan> = new Map();
  private metrics: PerformanceMetric[] = [];
  private serviceName: string;

  constructor(serviceName: string = "default-service") {
    this.serviceName = serviceName;
  }

  // ─── Tracing ──────────────────────────────────────────────────────────────

  /**
   * Start a new trace.
   */
  startTrace(name: string): Trace {
    const id = IdGenerators.trace();
    const trace: Trace = {
      id,
      name,
      startTime: new Date().toISOString(),
      endTime: "",
      duration: 0,
      spans: [],
      status: "pending",
    };

    this.traces.set(id, trace);
    return trace;
  }

  /**
   * End a trace.
   */
  endTrace(traceId: string, status: "success" | "error" = "success"): Trace | null {
    const trace = this.traces.get(traceId);
    if (!trace) return null;

    trace.endTime = new Date().toISOString();
    trace.duration =
      new Date(trace.endTime).getTime() - new Date(trace.startTime).getTime();
    trace.status = status;

    return trace;
  }

  /**
   * Start a span within a trace.
   */
  startSpan(
    traceId: string,
    name: string,
    operation: string,
    parentId?: string,
  ): TraceSpan {
    const span: TraceSpan = {
      id: IdGenerators.span(),
      traceId,
      parentId,
      name,
      operation,
      duration: 0,
      startTime: new Date().toISOString(),
      endTime: "",
      status: "pending",
      tags: {},
      logs: [],
    };

    this.spans.set(span.id, span);

    // Add span to trace
    const trace = this.traces.get(traceId);
    if (trace) {
      trace.spans.push(span);
    }

    return span;
  }

  /**
   * End a span.
   */
  endSpan(spanId: string, status: "success" | "error" = "success"): TraceSpan | null {
    const span = this.spans.get(spanId);
    if (!span) return null;

    span.endTime = new Date().toISOString();
    span.duration =
      new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
    span.status = status;

    return span;
  }

  /**
   * Add tag to span.
   */
  addTag(spanId: string, key: string, value: unknown): void {
    const span = this.spans.get(spanId);
    if (span) {
      span.tags[key] = value;
    }
  }

  /**
   * Add log entry to span.
   */
  addLog(spanId: string, message: string): void {
    const span = this.spans.get(spanId);
    if (span) {
      span.logs.push({
        timestamp: new Date().toISOString(),
        message,
      });
    }
  }

  /**
   * Get trace by ID.
   */
  getTrace(traceId: string): Trace | null {
    return this.traces.get(traceId) || null;
  }

  /**
   * Get recent traces.
   */
  getRecentTraces(limit = 10): Trace[] {
    return [...this.traces.values()]
      .filter((t) => t.endTime) // completed traces
      .sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())
      .slice(0, limit);
  }

  /**
   * Get slow traces (above or equal to threshold).
   */
  getSlowTraces(thresholdMs: number = 1000): Trace[] {
    return [...this.traces.values()].filter((t) => t.endTime && t.duration >= thresholdMs);
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────

  /**
   * Record performance metric.
   */
  recordMetric(name: string, value: number, unit: string = "ms"): void {
    this.metrics.push({
      name,
      value,
      unit,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get service metrics.
   */
  getServiceMetrics(): ServiceMetrics {
    const traces = [...this.traces.values()].filter((t) => t.endTime);
    const responseTimes = traces.map((t) => t.duration).sort((a, b) => a - b);

    const getPercentile = (p: number): number => {
      if (responseTimes.length === 0) return 0;
      const index = Math.ceil((responseTimes.length * p) / 100) - 1;
      return Math.max(0, responseTimes[index] || 0);
    };

    const errors = traces.filter((t) => t.status === "error").length;
    const totalDuration = traces.reduce((sum, t) => sum + t.duration, 0);
    const avgResponseTime =
      traces.length > 0 ? totalDuration / traces.length : 0;

    // Calculate throughput (requests per second)
    const timespan =
      traces.length > 0
        ? (new Date(traces[traces.length - 1].startTime).getTime() -
            new Date(traces[0].startTime).getTime()) /
          1000
        : 0;
    const throughput = timespan > 0 ? traces.length / timespan : 0;

    return {
      serviceName: this.serviceName,
      requestCount: traces.length,
      errorCount: errors,
      averageResponseTime: Math.round(avgResponseTime),
      p95ResponseTime: getPercentile(95),
      p99ResponseTime: getPercentile(99),
      throughput: Math.round(throughput * 100) / 100,
    };
  }

  /**
   * Get metrics by name.
   */
  getMetricsByName(name: string): PerformanceMetric[] {
    return this.metrics.filter((m) => m.name === name);
  }

  /**
   * Get all metrics.
   */
  getAllMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  /**
   * Get metric statistics.
   */
  getMetricStats(name: string): {
    min: number;
    max: number;
    average: number;
    count: number;
  } | null {
    const metrics = this.getMetricsByName(name);
    if (metrics.length === 0) return null;

    const values = metrics.map((m) => m.value);
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      min: Math.min(...values),
      max: Math.max(...values),
      average: sum / values.length,
      count: values.length,
    };
  }

  // ─── Health Check ────────────────────────────────────────────────────────

  /**
   * Check service health based on metrics.
   */
  checkHealth(): { healthy: boolean; status: string; metrics: ServiceMetrics } {
    const metrics = this.getServiceMetrics();
    const errorRate = metrics.requestCount > 0 ? metrics.errorCount / metrics.requestCount : 0;

    let healthy = true;
    let status = "healthy";

    if (metrics.averageResponseTime > 2000) {
      healthy = false;
      status = "degraded - slow response times";
    } else if (errorRate > 0.05) {
      // > 5% error rate
      healthy = false;
      status = "unhealthy - high error rate";
    }

    return { healthy, status, metrics };
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getTraceCache(): Map<string, Trace> {
    return this.traces;
  }

  getSpanCache(): Map<string, TraceSpan> {
    return this.spans;
  }

  getMetricsCache(): PerformanceMetric[] {
    return this.metrics;
  }
}

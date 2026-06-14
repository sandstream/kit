import { IdGenerators } from "./id-generator.js";
// ─── Datadog APM & Analytics Adapter ──────────────────────────────────────

import {
  AbstractServiceAdapter,
  type ServiceConfig,
  type ServiceEvent,
  type ServiceHealth,
} from "./service-adapter.js";

/**
 * Datadog adapter for APM, metrics, and analytics.
 */
export class DatadogAdapter extends AbstractServiceAdapter {
  private lastHealthCheck: string = new Date().toISOString();
  private healthCheckErrors: number = 0;
  private metrics: Map<string, number> = new Map();
  private traces: Map<string, { startTime: number; endTime?: number; status: string }> = new Map();

  constructor(config: ServiceConfig = { enabled: false }) {
    super("datadog", "1.0.0", config);
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.connected = false;
      return;
    }

    if (!this.config.apiKey) {
      throw new Error("Datadog API Key is required");
    }

    // Validate API key format (should be alphanumeric)
    if (!this.config.apiKey.match(/^[a-f0-9]{32}$/i)) {
      throw new Error("Invalid Datadog API Key format");
    }

    // Simulate connection test
    await new Promise((resolve) => setTimeout(resolve, 50));

    this.connected = true;

    // Flush queued events
    await this.flushQueue();
  }

  async disconnect(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.metrics.clear();
    this.traces.clear();
    this.connected = false;
  }

  async getHealth(): Promise<ServiceHealth> {
    const responseTime = Math.random() * 50;

    try {
      if (!this.connected) {
        this.healthCheckErrors++;
      }

      this.lastHealthCheck = new Date().toISOString();

      const status =
        this.healthCheckErrors < 3
          ? this.connected
            ? "healthy"
            : "degraded"
          : "unhealthy";

      return {
        status,
        lastCheck: this.lastHealthCheck,
        responseTime: Math.round(responseTime),
        errorCount: this.healthCheckErrors,
      };
    } catch {
      this.healthCheckErrors++;
      return {
        status: "unhealthy",
        lastCheck: new Date().toISOString(),
        responseTime: -1,
        errorCount: this.healthCheckErrors,
      };
    }
  }

  protected async sendEvent(event: ServiceEvent): Promise<void> {
    if (!this.connected) {
      throw new Error("Not connected to Datadog");
    }

    // Validate event
    if (!event.type || !event.data) {
      throw new Error("Invalid event format");
    }

    // Simulate sending to Datadog (fixed delay to avoid flaky tests)
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Simulate occasional failures (disabled in test — use explicit error injection instead)
    // if (Math.random() < 0.01) {
    //   throw new Error("Simulated Datadog API error");
    // }
  }

  /**
   * Record a metric value.
   */
  async recordMetric(
    name: string,
    value: number,
    tags?: Record<string, string>,
  ): Promise<boolean> {
    this.metrics.set(name, value);

    const event: ServiceEvent = {
      type: "metric",
      data: {
        name,
        value,
        tags,
        timestamp: Date.now(),
      },
      timestamp: new Date().toISOString(),
    };

    return this.send(event);
  }

  /**
   * Increment a metric counter.
   */
  async incrementMetric(name: string, increment: number = 1): Promise<boolean> {
    const current = this.metrics.get(name) || 0;
    this.metrics.set(name, current + increment);

    return this.recordMetric(name, current + increment);
  }

  /**
   * Get current metric value.
   */
  getMetric(name: string): number | undefined {
    return this.metrics.get(name);
  }

  /**
   * Start a trace span.
   */
  async startSpan(
    traceId: string,
    spanName: string,
    parentSpanId?: string,
  ): Promise<string> {
    const spanId = `${traceId}-${IdGenerators.span().slice(-12)}`;

    this.traces.set(spanId, {
      startTime: Date.now(),
      status: "active",
    });

    const event: ServiceEvent = {
      type: "trace",
      data: {
        traceId,
        spanId,
        spanName,
        parentSpanId,
        startTime: Date.now(),
      },
      timestamp: new Date().toISOString(),
      tags: {
        spanType: "span",
      },
    };

    await this.send(event);
    return spanId;
  }

  /**
   * End a trace span.
   */
  async endSpan(spanId: string, status: "ok" | "error" = "ok"): Promise<void> {
    const span = this.traces.get(spanId);
    if (span) {
      span.endTime = Date.now();
      span.status = status;
    }

    const event: ServiceEvent = {
      type: "trace",
      data: {
        spanId,
        status,
        endTime: Date.now(),
        duration: span ? span.endTime! - span.startTime : 0,
      },
      timestamp: new Date().toISOString(),
      tags: {
        spanType: "span-end",
      },
    };

    await this.send(event);
  }

  /**
   * Record a log event.
   */
  async logEvent(
    message: string,
    level: "debug" | "info" | "warning" | "error" = "info",
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const event: ServiceEvent = {
      type: "log",
      data: {
        message,
        level,
        metadata,
      },
      timestamp: new Date().toISOString(),
      tags: {
        level,
      },
    };

    return this.send(event);
  }

  /**
   * Record a custom event/incident.
   */
  async recordEvent(
    title: string,
    text: string,
    tags?: Record<string, string>,
    severity?: "low" | "medium" | "high" | "critical",
  ): Promise<boolean> {
    const event: ServiceEvent = {
      type: "event",
      data: {
        title,
        text,
        severity,
        timestamp: Date.now(),
      },
      timestamp: new Date().toISOString(),
      tags: {
        ...tags,
        severity: severity || "medium",
      },
    };

    return this.send(event);
  }

  /**
   * Flush all queued events.
   */
  private async flushQueue(): Promise<void> {
    const queued = this.getQueuedEvents();
    if (queued.length === 0) return;

    const { sent, failed } = await this.batch(queued);

    if (sent > 0) {
      this.clearQueue();
    }

    console.log(`Flushed Datadog queue: ${sent} sent, ${failed} failed`);
  }

  /**
   * Get Datadog site configuration.
   */
  getSiteInfo(): {
    apiKey: string;
    site?: string;
    metricsCount: number;
    tracesCount: number;
  } {
    return {
      apiKey: this.config.apiKey || "",
      site: this.config.endpoint || "datadoghq.com",
      metricsCount: this.metrics.size,
      tracesCount: this.traces.size,
    };
  }
}

/**
 * Create a Datadog adapter from environment variables.
 */
export function createDatadogAdapter(enabled: boolean = true): DatadogAdapter {
  const apiKey = process.env.DATADOG_API_KEY;
  const site = process.env.DATADOG_SITE || "datadoghq.com";

  if (enabled && !apiKey) {
    console.warn("Datadog is enabled but DATADOG_API_KEY environment variable is not set");
  }

  return new DatadogAdapter({
    enabled: enabled && !!apiKey,
    apiKey,
    endpoint: site,
  });
}

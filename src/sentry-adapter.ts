import { IdGenerators } from "./id-generator.js";
// ─── Sentry Error Tracking Adapter ────────────────────────────────────────────

import {
  AbstractServiceAdapter,
  simulatedFailuresEnabled,
  type ServiceConfig,
  type ServiceEvent,
  type ServiceHealth,
} from "./service-adapter.js";

/**
 * Sentry adapter for error tracking and exception monitoring.
 */
export class SentryAdapter extends AbstractServiceAdapter {
  private lastHealthCheck: string = new Date().toISOString();
  private healthCheckErrors: number = 0;

  constructor(config: ServiceConfig = { enabled: false }) {
    super("sentry", "1.0.0", config);
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.connected = false;
      return;
    }

    if (!this.config.dsn) {
      throw new Error("Sentry DSN is required");
    }

    // Parse DSN to validate format
    try {
      const url = new URL(this.config.dsn);
      if (!url.protocol.includes("http")) {
        throw new Error("Invalid DSN protocol");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Invalid DSN protocol")) {
        throw error;
      }
      throw new Error("Invalid Sentry DSN format");
    }

    // Simulate connection test
    await new Promise((resolve) => setTimeout(resolve, 100));

    this.connected = true;

    // Flush queued events
    await this.flushQueue();
  }

  async disconnect(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.connected = false;
  }

  async getHealth(): Promise<ServiceHealth> {
    const responseTime = Math.random() * 100; // Simulate response time

    try {
      // Simulate health check
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
      throw new Error("Not connected to Sentry");
    }

    // Validate event
    if (!event.type || !event.data) {
      throw new Error("Invalid event format");
    }

    // Simulate sending to Sentry
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));

    // Simulate occasional failures
    if (simulatedFailuresEnabled() && Math.random() < 0.02) {
      // 2% failure rate
      throw new Error("Simulated Sentry API error");
    }
  }

  /**
   * Capture an exception.
   */
  async captureException(error: Error, context?: Record<string, unknown>): Promise<boolean> {
    const event: ServiceEvent = {
      type: "error",
      data: {
        message: error.message,
        stack: error.stack,
        name: error.name,
        ...context,
      },
      timestamp: new Date().toISOString(),
      tags: {
        errorType: "exception",
      },
    };

    return this.send(event);
  }

  /**
   * Capture a message.
   */
  async captureMessage(
    message: string,
    level: "debug" | "info" | "warning" | "error" | "fatal" = "info",
  ): Promise<boolean> {
    const event: ServiceEvent = {
      type: "log",
      data: {
        message,
        level,
      },
      timestamp: new Date().toISOString(),
      tags: {
        level,
      },
    };

    return this.send(event);
  }

  /**
   * Start a transaction (for performance monitoring).
   */
  async startTransaction(name: string, op: string = "http.request"): Promise<string> {
    const transactionId = IdGenerators.transaction();

    const event: ServiceEvent = {
      type: "trace",
      data: {
        transactionId,
        name,
        operation: op,
        startTime: Date.now(),
      },
      timestamp: new Date().toISOString(),
    };

    await this.send(event);
    return transactionId;
  }

  /**
   * End a transaction.
   */
  async endTransaction(transactionId: string, status: "ok" | "error" = "ok"): Promise<void> {
    const event: ServiceEvent = {
      type: "trace",
      data: {
        transactionId,
        status,
        endTime: Date.now(),
      },
      timestamp: new Date().toISOString(),
    };

    await this.send(event);
  }

  /**
   * Set user context.
   */
  async setUser(userId: string, metadata?: Record<string, unknown>): Promise<void> {
    const event: ServiceEvent = {
      type: "event",
      data: {
        userId,
        metadata,
      },
      timestamp: new Date().toISOString(),
      tags: {
        context: "user",
      },
    };

    await this.send(event);
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

    console.log(`Flushed Sentry queue: ${sent} sent, ${failed} failed`);
  }

  /**
   * Get Sentry project info.
   */
  getProjectInfo(): {
    dsn: string;
    projectId?: string;
    organization?: string;
  } {
    const info: {
      dsn: string;
      projectId?: string;
      organization?: string;
    } = {
      dsn: this.config.dsn || "",
    };

    if (this.config.dsn) {
      try {
        const url = new URL(this.config.dsn);
        const parts = url.pathname.split("/");
        info.projectId = parts[parts.length - 1];
        info.organization = parts[parts.length - 2];
      } catch {
        // Ignore parsing errors
      }
    }

    return info;
  }
}

/**
 * Create a Sentry adapter from environment variables.
 */
export function createSentryAdapter(enabled: boolean = true): SentryAdapter {
  const dsn = process.env.SENTRY_DSN;

  if (enabled && !dsn) {
    console.warn("Sentry is enabled but SENTRY_DSN environment variable is not set");
  }

  return new SentryAdapter({
    enabled: enabled && !!dsn,
    dsn,
  });
}

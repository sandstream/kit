// ─── CDN Integration Adapter (CloudFront/Cloudflare) ────────────────────

import {
  AbstractServiceAdapter,
  simulatedFailuresEnabled,
  type ServiceConfig,
  type ServiceEvent,
  type ServiceHealth,
} from "./service-adapter.js";

/**
 * CDN adapter for CloudFront and Cloudflare integration.
 */
export class CDNAdapter extends AbstractServiceAdapter {
  private lastHealthCheck: string = new Date().toISOString();
  private healthCheckErrors: number = 0;
  private cacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    invalidations: 0,
  };

  constructor(config: ServiceConfig = { enabled: false }) {
    super("cdn", "1.0.0", config);
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.connected = false;
      return;
    }

    // Validate required config
    if (!this.config.apiKey) {
      throw new Error("CDN API Key is required");
    }

    if (!this.config.endpoint) {
      throw new Error("CDN endpoint/distribution ID is required");
    }

    // Simulate connection test
    await new Promise((resolve) => setTimeout(resolve, 75));

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
    const responseTime = Math.random() * 100;

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
      throw new Error("Not connected to CDN");
    }

    // Validate event
    if (!event.type || !event.data) {
      throw new Error("Invalid event format");
    }

    // Simulate CDN API call
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 75));

    // Simulate occasional failures (0.2% rate for CDN)
    if (simulatedFailuresEnabled() && Math.random() < 0.002) {
      throw new Error("Simulated CDN API error");
    }
  }

  /**
   * Purge cache for specific paths.
   */
  async purge(paths: string[]): Promise<boolean> {
    const event: ServiceEvent = {
      type: "event",
      data: {
        operation: "purge",
        paths,
        count: paths.length,
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "purge",
      },
    };

    const success = await this.send(event);

    if (success) {
      this.cacheStats.invalidations += paths.length;
    }

    return success;
  }

  /**
   * Purge all cache.
   */
  async purgeAll(): Promise<boolean> {
    const event: ServiceEvent = {
      type: "event",
      data: {
        operation: "purge_all",
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "purge_all",
      },
    };

    const success = await this.send(event);

    if (success) {
      this.cacheStats.invalidations++;
    }

    return success;
  }

  /**
   * Record cache hit.
   */
  async recordCacheHit(path: string, sizeBytes?: number): Promise<boolean> {
    const event: ServiceEvent = {
      type: "metric",
      data: {
        operation: "cache_hit",
        path,
        sizeBytes,
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "cache_hit",
      },
    };

    const success = await this.send(event);

    if (success) {
      this.cacheStats.hits++;
    }

    return success;
  }

  /**
   * Record cache miss.
   */
  async recordCacheMiss(path: string, sizeBytes?: number): Promise<boolean> {
    const event: ServiceEvent = {
      type: "metric",
      data: {
        operation: "cache_miss",
        path,
        sizeBytes,
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "cache_miss",
      },
    };

    const success = await this.send(event);

    if (success) {
      this.cacheStats.misses++;
    }

    return success;
  }

  /**
   * Set cache headers.
   */
  async setCachePolicy(
    pathPattern: string,
    ttl: number,
    cacheKeyPolicy?: Record<string, string>,
  ): Promise<boolean> {
    const event: ServiceEvent = {
      type: "event",
      data: {
        operation: "set_cache_policy",
        pathPattern,
        ttl,
        cacheKeyPolicy,
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "set_cache_policy",
      },
    };

    return this.send(event);
  }

  /**
   * Get current cache statistics.
   */
  getCacheStats(): {
    hits: number;
    misses: number;
    evictions: number;
    invalidations: number;
    hitRate: number;
  } {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const hitRate = total > 0 ? (this.cacheStats.hits / total) * 100 : 0;

    return {
      ...this.cacheStats,
      hitRate: Math.round(hitRate * 100) / 100,
    };
  }

  /**
   * Record cache eviction.
   */
  async recordEviction(): Promise<boolean> {
    const event: ServiceEvent = {
      type: "metric",
      data: {
        operation: "eviction",
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "eviction",
      },
    };

    const success = await this.send(event);

    if (success) {
      this.cacheStats.evictions++;
    }

    return success;
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

    console.log(`Flushed CDN queue: ${sent} sent, ${failed} failed`);
  }

  /**
   * Get CDN configuration info.
   */
  getInfo(): {
    provider: string;
    endpoint: string;
    apiKey: string;
  } {
    const provider = this.config.endpoint?.includes("cloudflare") ? "cloudflare" : "cloudfront";

    return {
      provider,
      endpoint: this.config.endpoint || "",
      apiKey: this.config.apiKey ? "***" : "",
    };
  }
}

/**
 * Create a CDN adapter from environment variables.
 */
export function createCDNAdapter(enabled: boolean = true): CDNAdapter {
  const apiKey = process.env.CDN_API_KEY;
  const endpoint = process.env.CDN_ENDPOINT || process.env.CLOUDFRONT_DISTRIBUTION_ID;

  if (enabled && (!apiKey || !endpoint)) {
    console.warn(
      "CDN is enabled but CDN_API_KEY and CDN_ENDPOINT environment variables are required",
    );
  }

  return new CDNAdapter({
    enabled: enabled && !!apiKey && !!endpoint,
    apiKey,
    endpoint,
  });
}

// ─── Redis Cache Adapter ─────────────────────────────────────────────────

import {
  AbstractServiceAdapter,
  simulatedFailuresEnabled,
  type ServiceConfig,
  type ServiceEvent,
  type ServiceHealth,
} from "./service-adapter.js";

/**
 * Redis adapter for caching and session management.
 */
export class RedisAdapter extends AbstractServiceAdapter {
  private cache: Map<string, { value: unknown; expireAt?: number }> = new Map();
  private lastHealthCheck: string = new Date().toISOString();
  private healthCheckErrors: number = 0;
  private stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
  };

  constructor(config: ServiceConfig = { enabled: false }) {
    super("redis", "1.0.0", config);
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.connected = false;
      return;
    }

    // Validate required config
    if (!this.config.endpoint) {
      throw new Error("Redis endpoint is required (host:port)");
    }

    // Basic endpoint format validation
    const [host, port] = this.config.endpoint.split(":");
    if (!host) {
      throw new Error("Invalid Redis endpoint format");
    }

    if (port && isNaN(parseInt(port))) {
      throw new Error("Invalid Redis port number");
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
    this.cache.clear();
    this.connected = false;
  }

  async getHealth(): Promise<ServiceHealth> {
    const responseTime = Math.random() * 30;

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
      throw new Error("Not connected to Redis");
    }

    // Validate event
    if (!event.type || !event.data) {
      throw new Error("Invalid event format");
    }

    // Simulate Redis operation
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));

    // Simulate occasional failures (0.5% rate for Redis)
    if (simulatedFailuresEnabled() && Math.random() < 0.005) {
      throw new Error("Simulated Redis error");
    }
  }

  /**
   * Set a cache value.
   */
  async set(
    key: string,
    value: unknown,
    ttl?: number,
  ): Promise<boolean> {
    const expireAt = ttl ? Date.now() + ttl * 1000 : undefined;

    const event: ServiceEvent = {
      type: "event",
      data: {
        operation: "set",
        key,
        value,
        ttl,
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "set",
      },
    };

    const success = await this.send(event);

    if (success) {
      this.cache.set(key, { value, expireAt });
      this.stats.sets++;
    }

    return success;
  }

  /**
   * Get a cache value.
   */
  async get(key: string): Promise<unknown> {
    const event: ServiceEvent = {
      type: "event",
      data: {
        operation: "get",
        key,
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "get",
      },
    };

    await this.send(event);

    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check expiration
    if (entry.expireAt && entry.expireAt < Date.now()) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    this.stats.hits++;
    return entry.value;
  }

  /**
   * Delete a cache key.
   */
  async delete(key: string): Promise<boolean> {
    const event: ServiceEvent = {
      type: "event",
      data: {
        operation: "delete",
        key,
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "delete",
      },
    };

    const success = await this.send(event);

    if (success) {
      const deleted = this.cache.delete(key);
      if (deleted) {
        this.stats.deletes++;
      }
    }

    return success;
  }

  /**
   * Check if key exists.
   */
  async exists(key: string): Promise<boolean> {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    // Check expiration
    if (entry.expireAt && entry.expireAt < Date.now()) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Clear all cache.
   */
  async clear(): Promise<boolean> {
    const event: ServiceEvent = {
      type: "event",
      data: {
        operation: "clear",
      },
      timestamp: new Date().toISOString(),
      tags: {
        operation: "clear",
      },
    };

    const success = await this.send(event);

    if (success) {
      this.cache.clear();
    }

    return success;
  }

  /**
   * Get all cache keys.
   */
  keys(): string[] {
    const now = Date.now();
    const validKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      // Skip expired keys
      if (!entry.expireAt || entry.expireAt >= now) {
        validKeys.push(key);
      }
    }

    return validKeys;
  }

  /**
   * Get cache size.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): {
    hits: number;
    misses: number;
    sets: number;
    deletes: number;
    hitRate: number;
    size: number;
  } {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;

    return {
      ...this.stats,
      hitRate: Math.round(hitRate * 100) / 100,
      size: this.cache.size,
    };
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

    console.log(`Flushed Redis queue: ${sent} sent, ${failed} failed`);
  }

  /**
   * Get Redis configuration info.
   */
  getInfo(): {
    endpoint: string;
    connected: boolean;
    cacheSize: number;
    keyCount: number;
  } {
    return {
      endpoint: this.config.endpoint || "",
      connected: this.connected,
      cacheSize: this.cache.size,
      keyCount: this.keys().length,
    };
  }
}

/**
 * Create a Redis adapter from environment variables.
 */
export function createRedisAdapter(enabled: boolean = true): RedisAdapter {
  const endpoint = process.env.REDIS_URL || process.env.REDIS_ENDPOINT;

  if (enabled && !endpoint) {
    console.warn(
      "Redis is enabled but REDIS_URL/REDIS_ENDPOINT environment variable is not set",
    );
  }

  return new RedisAdapter({
    enabled: enabled && !!endpoint,
    endpoint,
  });
}

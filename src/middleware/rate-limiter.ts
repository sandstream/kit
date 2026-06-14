/**
 * Rate Limiting Middleware
 *
 * Redis-based distributed rate limiting with tier-based quotas.
 * Implements token bucket algorithm for fair rate limiting.
 *
 * Limits by tier:
 * - Free: 100 req/min, 10k req/day, 100 concurrent
 * - Team: 1k req/min, 100k req/day, 1k concurrent
 * - Enterprise: Custom (negotiated)
 */

import { Redis } from '@upstash/redis';
import { appendAuditEventDirect } from '../audit.js';

/**
 * On Redis failure the limiter defaults to fail-closed (reject). The
 * previous "fail-open" behavior turned a Redis outage into an unlimited
 * burst window with no audit trail. Operators who knowingly accept that
 * trade-off (e.g. a development environment where Redis is not yet wired
 * up) opt in via `KIT_RATE_LIMIT_FAIL_OPEN=1`. The opt-in emits a
 * one-time stderr warning and an audit event so the choice is visible.
 */
let warnedAboutFailOpen = false;
function failOpenAllowed(identifier: string): boolean {
  if (process.env.KIT_RATE_LIMIT_FAIL_OPEN !== '1') return false;
  if (!warnedAboutFailOpen) {
    warnedAboutFailOpen = true;
    console.error(
      '[kit] WARNING: KIT_RATE_LIMIT_FAIL_OPEN=1 active — rate-limiter is fail-open on Redis errors.',
    );
    void appendAuditEventDirect({
      operation: 'rate-limit-fail-open-enabled',
      environment: process.env.NODE_ENV ?? 'unknown',
      success: true,
      metadata: { identifier },
    });
  }
  return true;
}

/**
 * Test-only: reset the module-scoped fail-open warning flag.
 */
export function _resetFailOpenWarningForTests(): void {
  warnedAboutFailOpen = false;
}

// Rate limit tiers
export type UserTier = 'free' | 'team' | 'enterprise';

export const RATE_LIMITS: Record<UserTier, {
  requestsPerMinute: number;
  requestsPerDay: number;
  concurrentConnections: number;
  burstMultiplier: number;
}> = {
  free: {
    requestsPerMinute: 100,
    requestsPerDay: 10_000,
    concurrentConnections: 100,
    burstMultiplier: 1.5,
  },
  team: {
    requestsPerMinute: 1_000,
    requestsPerDay: 100_000,
    concurrentConnections: 1_000,
    burstMultiplier: 1.2,
  },
  enterprise: {
    requestsPerMinute: 10_000,
    requestsPerDay: 10_000_000,
    concurrentConnections: 10_000,
    burstMultiplier: 1.1,
  },
};

// Rate limit keys
type RateLimitKey = 'minute' | 'day' | 'concurrent';

interface RateLimitStatus {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfter?: number;
}

export class RateLimiter {
  private redis: Redis;

  constructor(redisUrl?: string) {
    this.redis = new Redis({
      url: redisUrl || process.env.REDIS_URL,
      token: process.env.REDIS_TOKEN,
    });
  }

  /**
   * Check rate limit for user/API key
   */
  async checkLimit(
    identifier: string,
    tier: UserTier = 'free',
    keyType: RateLimitKey = 'minute'
  ): Promise<RateLimitStatus> {
    const limits = RATE_LIMITS[tier];
    const limit = this.getLimitForKey(limits, keyType);
    const ttl = this.getTTLForKey(keyType);
    const key = this.buildKey(identifier, keyType);

    try {
      // Get current count
      const count = await this.redis.incr(key);

      // Set expiry on first request
      if (count === 1) {
        await this.redis.expire(key, ttl);
      }

      // Check if limit exceeded
      if (count > limit) {
        const ttlRemaining = await this.redis.ttl(key);
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetAt: new Date(Date.now() + (ttlRemaining * 1000)),
          retryAfter: ttlRemaining,
        };
      }

      // Calculate reset time
      const ttlRemaining = await this.redis.ttl(key);
      const resetAt = new Date(Date.now() + (ttlRemaining * 1000));

      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - count),
        resetAt,
      };
    } catch (error) {
      console.error('Rate limiter error:', error);
      void appendAuditEventDirect({
        operation: 'rate-limit-redis-error',
        environment: process.env.NODE_ENV ?? 'unknown',
        success: false,
        error: String(error instanceof Error ? error.message : error),
        metadata: { identifier, tier, keyType },
      });
      if (failOpenAllowed(identifier)) {
        return {
          allowed: true,
          limit,
          remaining: limit - 1,
          resetAt: new Date(Date.now() + 60000),
        };
      }
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: new Date(Date.now() + 60000),
        retryAfter: 60,
      };
    }
  }

  /**
   * Check concurrent connections
   */
  async checkConcurrent(
    identifier: string,
    tier: UserTier = 'free'
  ): Promise<RateLimitStatus> {
    const limits = RATE_LIMITS[tier];
    const limit = limits.concurrentConnections;
    const key = this.buildKey(identifier, 'concurrent');

    try {
      const count = await this.redis.incr(key);

      // Set TTL (clear after 1 hour of inactivity)
      if (count === 1) {
        await this.redis.expire(key, 3600);
      }

      if (count > limit) {
        // Decrement on failure
        await this.redis.decr(key);
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetAt: new Date(Date.now() + 60000),
        };
      }

      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - count),
        resetAt: new Date(Date.now() + 3600000),
      };
    } catch (error) {
      console.error('Concurrent limit error:', error);
      void appendAuditEventDirect({
        operation: 'rate-limit-redis-error',
        environment: process.env.NODE_ENV ?? 'unknown',
        success: false,
        error: String(error instanceof Error ? error.message : error),
        metadata: { identifier, tier, keyType: 'concurrent' },
      });
      if (failOpenAllowed(identifier)) {
        return {
          allowed: true,
          limit,
          remaining: limit - 1,
          resetAt: new Date(Date.now() + 3600000),
        };
      }
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: new Date(Date.now() + 3600000),
      };
    }
  }

  /**
   * Release concurrent connection
   */
  async releaseConcurrent(
    identifier: string,
    _tier: UserTier = 'free'
  ): Promise<void> {
    const key = this.buildKey(identifier, 'concurrent');
    try {
      await this.redis.decr(key);
    } catch (error) {
      console.error('Failed to release concurrent connection:', error);
    }
  }

  /**
   * Reset limits (for testing or manual override)
   */
  async reset(identifier: string): Promise<void> {
    const keys = [
      this.buildKey(identifier, 'minute'),
      this.buildKey(identifier, 'day'),
      this.buildKey(identifier, 'concurrent'),
    ];

    try {
      await Promise.all(keys.map(key => this.redis.del(key)));
    } catch (error) {
      console.error('Failed to reset rate limits:', error);
    }
  }

  private buildKey(identifier: string, type: RateLimitKey): string {
    return `ratelimit:${identifier}:${type}`;
  }

  private getLimitForKey(
    limits: typeof RATE_LIMITS[UserTier],
    keyType: RateLimitKey
  ): number {
    switch (keyType) {
      case 'minute':
        return limits.requestsPerMinute;
      case 'day':
        return limits.requestsPerDay;
      case 'concurrent':
        return limits.concurrentConnections;
    }
  }

  private getTTLForKey(keyType: RateLimitKey): number {
    switch (keyType) {
      case 'minute':
        return 60;
      case 'day':
        return 86400;
      case 'concurrent':
        return 3600;
    }
  }
}

// Middleware function (framework-agnostic)
export async function rateLimitMiddleware(
  getHeaders: () => Record<string, string | null>,
  getIP: () => string,
  getUserTier: (userId: string) => Promise<UserTier> = async () => 'free'
): Promise<{ allowed: boolean; headers: Record<string, string> }> {
  const limiter = new RateLimiter();
  const headers = getHeaders();

  // Extract user identifier
  const userId = headers['x-user-id'] ||
    headers['authorization']?.split(' ')[1] ||
    getIP() ||
    'anonymous';

  // Get user tier
  const tier = await getUserTier(userId);

  // Check rate limits
  const minuteLimit = await limiter.checkLimit(userId, tier, 'minute');
  const dayLimit = await limiter.checkLimit(userId, tier, 'day');

  // Build response headers
  const responseHeaders: Record<string, string> = {
    'X-RateLimit-Limit': String(minuteLimit.limit),
    'X-RateLimit-Remaining': String(minuteLimit.remaining),
    'X-RateLimit-Reset': minuteLimit.resetAt.toISOString(),
  };

  // Check if limited
  if (!minuteLimit.allowed || !dayLimit.allowed) {
    const status = !minuteLimit.allowed ? minuteLimit : dayLimit;
    responseHeaders['Retry-After'] = String(status.retryAfter || 60);
    responseHeaders['X-RateLimit-Remaining'] = '0';

    return {
      allowed: false,
      headers: responseHeaders,
    };
  }

  return {
    allowed: true,
    headers: responseHeaders,
  };
}

// Client-side exponential backoff helper
export class RateLimitClient {
  private static MIN_BACKOFF_MS = 1000;
  private static MAX_BACKOFF_MS = 32000;

  /**
   * Parse rate limit response and calculate backoff
   */
  static getBackoffMs(response: Response): number {
    // Check for explicit Retry-After header
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      return seconds * 1000;
    }

    // Calculate from X-RateLimit-Reset
    const resetAt = response.headers.get('X-RateLimit-Reset');
    if (resetAt) {
      const resetTime = new Date(resetAt).getTime();
      const now = Date.now();
      const delay = Math.max(0, resetTime - now);
      return delay + 100; // Add 100ms buffer
    }

    // Default exponential backoff
    return this.MIN_BACKOFF_MS;
  }

  /**
   * Exponential backoff with jitter
   */
  static exponentialBackoff(attempt: number): number {
    const exponential = Math.min(
      this.MAX_BACKOFF_MS,
      this.MIN_BACKOFF_MS * Math.pow(2, attempt)
    );

    // Add jitter (±10%)
    const jitter = exponential * 0.1 * (Math.random() - 0.5) * 2;
    return Math.round(exponential + jitter);
  }

  /**
   * Retry with backoff
   */
  static async retryWithBackoff<T>(
    fn: () => Promise<Response>,
    maxAttempts: number = 3
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fn();

        if (response.status === 429) {
          // Rate limited
          if (attempt < maxAttempts - 1) {
            const backoff = this.getBackoffMs(response);
            await new Promise(resolve => setTimeout(resolve, backoff));
            continue;
          }
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
      } catch (error) {
        lastError = error as Error;

        if (attempt < maxAttempts - 1) {
          const backoff = this.exponentialBackoff(attempt);
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }
}

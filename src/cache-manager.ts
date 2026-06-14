// ─── Types ────────────────────────────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  ttl?: number; // seconds
  createdAt: string;
  expiresAt?: string;
  hits: number;
}

export interface CacheStats {
  totalSize: number;
  totalEntries: number;
  hitRate: number;
  evictions: number;
}

export interface CacheConfig {
  maxSize: number; // max entries
  defaultTtl: number; // seconds
  strategy: "lru" | "lfu" | "fifo";
}

// ─── CacheManager ────────────────────────────────────────────────────────────

export class CacheManager {
  private cache: Map<string, CacheEntry> = new Map();
  private hits: number = 0;
  private misses: number = 0;
  private evictions: number = 0;
  private config: CacheConfig;

  constructor(config: CacheConfig = { maxSize: 1000, defaultTtl: 3600, strategy: "lru" }) {
    this.config = config;
  }

  // ─── Basic Operations ──────────────────────────────────────────────────────

  /**
   * Set cache entry.
   */
  set<T>(key: string, value: T, ttl?: number): void {
    // Check capacity
    if (
      this.cache.size >= this.config.maxSize &&
      !this.cache.has(key)
    ) {
      this.evictEntry();
    }

    const expiresAt = ttl
      ? new Date(Date.now() + ttl * 1000).toISOString()
      : undefined;

    this.cache.set(key, {
      key,
      value,
      ttl,
      createdAt: new Date().toISOString(),
      expiresAt,
      hits: 0,
    });
  }

  /**
   * Get cache entry.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check expiration
    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Record hit
    entry.hits++;
    this.hits++;

    return entry.value as T;
  }

  /**
   * Check if key exists.
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check expiration
    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete cache entry.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  // ─── Cache Invalidation ────────────────────────────────────────────────────

  /**
   * Invalidate entries by pattern.
   */
  invalidatePattern(pattern: string): number {
    let count = 0;
    const regex = new RegExp(pattern);

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }

    return count;
  }

  /**
   * Invalidate entries by prefix.
   */
  invalidatePrefix(prefix: string): number {
    let count = 0;

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }

    return count;
  }

  /**
   * Clear expired entries.
   */
  cleanExpired(): number {
    let count = 0;
    const now = new Date();

    for (const entry of this.cache.values()) {
      if (entry.expiresAt && new Date(entry.expiresAt) < now) {
        this.cache.delete(entry.key);
        count++;
      }
    }

    return count;
  }

  // ─── Eviction Strategy ─────────────────────────────────────────────────────

  private evictEntry(): void {
    let keyToEvict: string | null = null;

    if (this.config.strategy === "lru") {
      // Least Recently Used: lowest hit count
      keyToEvict = this.findLRUKey();
    } else if (this.config.strategy === "lfu") {
      // Least Frequently Used: oldest entry
      keyToEvict = this.findLFUKey();
    } else if (this.config.strategy === "fifo") {
      // First In First Out: oldest by creation time
      keyToEvict = this.findFIFOKey();
    }

    if (keyToEvict) {
      this.cache.delete(keyToEvict);
      this.evictions++;
    }
  }

  private findLRUKey(): string | null {
    let minHits = Infinity;
    let oldestKey: string | null = null;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.hits < minHits) {
        minHits = entry.hits;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  private findLFUKey(): string | null {
    let minTime = Infinity;
    let oldestKey: string | null = null;

    for (const [key, entry] of this.cache.entries()) {
      const createdTime = new Date(entry.createdAt).getTime();
      if (createdTime < minTime) {
        minTime = createdTime;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  private findFIFOKey(): string | null {
    return this.cache.keys().next().value || null;
  }

  // ─── Statistics ────────────────────────────────────────────────────────────

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      totalSize: this.cache.size,
      totalEntries: this.cache.size,
      hitRate: Math.round(hitRate * 100) / 100,
      evictions: this.evictions,
    };
  }

  /**
   * Get hit count.
   */
  getHits(): number {
    return this.hits;
  }

  /**
   * Get miss count.
   */
  getMisses(): number {
    return this.misses;
  }

  /**
   * Get hit rate percentage.
   */
  getHitRate(): number {
    const total = this.hits + this.misses;
    if (total === 0) return 0;
    return Math.round((this.hits / total) * 100);
  }

  // ─── Cache Inspection ──────────────────────────────────────────────────────

  /**
   * Get all cache keys.
   */
  getKeys(): string[] {
    return [...this.cache.keys()];
  }

  /**
   * Get cache entry details.
   */
  getEntry<T>(key: string): CacheEntry<T> | null {
    const entry = this.cache.get(key);
    return entry ? (entry as CacheEntry<T>) : null;
  }

  /**
   * Get all entries.
   */
  getAllEntries(): CacheEntry[] {
    return [...this.cache.values()];
  }

  /**
   * Get size in bytes (rough estimate).
   */
  getApproximateSize(): number {
    let size = 0;

    for (const entry of this.cache.values()) {
      // Rough estimate: key length + value serialization
      size += entry.key.length + JSON.stringify(entry.value).length;
    }

    return size;
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getCacheMap(): Map<string, CacheEntry> {
    return this.cache;
  }

  getConfig(): CacheConfig {
    return this.config;
  }
}

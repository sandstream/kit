// ─── Types ────────────────────────────────────────────────────────────────────

export type CompressionAlgorithm = "gzip" | "brotli" | "deflate" | "none";

export interface CompressionConfig {
  algorithm: CompressionAlgorithm;
  level: number; // 1-11 for gzip, 0-11 for brotli
  minSize: number; // minimum bytes before compression
  mimeTypes: string[]; // mime types to compress
}

export interface CompressionMetrics {
  algorithm: CompressionAlgorithm;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  compressionTime: number;
}

// ─── CompressionManager ────────────────────────────────────────────────────

export class CompressionManager {
  private config: CompressionConfig;
  private metrics: CompressionMetrics[] = [];
  private compressionCache: Map<string, { data: string; hash: string }> = new Map();

  constructor(config: Partial<CompressionConfig> = {}) {
    this.config = {
      algorithm: config.algorithm || "gzip",
      level: config.level || 6,
      minSize: config.minSize || 1024,
      mimeTypes: config.mimeTypes || [
        "application/json",
        "text/html",
        "text/css",
        "application/javascript",
        "text/plain",
        "application/xml",
      ],
    };
  }

  // ─── Compression ──────────────────────────────────────────────────────────

  /**
   * Compress data.
   */
  compress(data: string): { compressed: string; metrics: CompressionMetrics } {
    const startTime = Date.now();
    const originalSize = Buffer.byteLength(data, "utf-8");

    // Don't compress if too small
    if (originalSize < this.config.minSize) {
      return {
        compressed: data,
        metrics: {
          algorithm: "none",
          originalSize,
          compressedSize: originalSize,
          ratio: 0,
          compressionTime: 0,
        },
      };
    }

    // Simulate compression based on algorithm
    const compressedSize = this.estimateCompressedSize(data, this.config.algorithm);
    const compressionTime = Date.now() - startTime;
    const ratio = ((originalSize - compressedSize) / originalSize) * 100;

    const metrics: CompressionMetrics = {
      algorithm: this.config.algorithm,
      originalSize,
      compressedSize,
      ratio: Math.round(ratio * 100) / 100,
      compressionTime,
    };

    this.metrics.push(metrics);

    // Return base64-encoded data with metadata for decompression
    const encoded = Buffer.from(data).toString("base64");
    const header = `[${this.config.algorithm}]`;
    const compressed = header + encoded;

    return { compressed, metrics };
  }

  /**
   * Decompress data.
   */
  decompress(data: string): string {
    // Simulate decompression - extract base64 part and decode
    try {
      // Check if data has algorithm header
      const match = data.match(/^\[([^\]]+)\](.+)$/);
      if (match) {
        const base64Part = match[2];
        return Buffer.from(base64Part, "base64").toString("utf-8");
      }
      // If it looks like base64, try to decode it
      if (/^[A-Za-z0-9+/=]+$/.test(data)) {
        return Buffer.from(data, "base64").toString("utf-8");
      }
      // Otherwise, return as-is (uncompressed data)
      return data;
    } catch {
      return data;
    }
  }

  /**
   * Estimate compressed size based on algorithm.
   */
  private estimateCompressedSize(data: string, algorithm: CompressionAlgorithm): number {
    const size = Buffer.byteLength(data, "utf-8");

    switch (algorithm) {
      case "gzip":
        // Gzip typically compresses text by 60-70%
        return Math.round(size * (0.3 + (11 - this.config.level) * 0.005));
      case "brotli":
        // Brotli is typically 5-15% better than gzip
        return Math.round(size * (0.25 + (11 - this.config.level) * 0.004));
      case "deflate":
        // Deflate is similar to gzip but slightly less efficient
        return Math.round(size * (0.35 + (11 - this.config.level) * 0.005));
      case "none":
      default:
        return size;
    }
  }

  /**
   * Should compress response based on mime type and size.
   */
  shouldCompress(mimeType: string, size: number): boolean {
    return (
      size >= this.config.minSize &&
      this.config.mimeTypes.some((mt) => mimeType.includes(mt))
    );
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  /**
   * Set compression algorithm.
   */
  setAlgorithm(algorithm: CompressionAlgorithm): void {
    this.config.algorithm = algorithm;
  }

  /**
   * Set compression level.
   */
  setCompressionLevel(level: number): void {
    this.config.level = Math.max(1, Math.min(11, level));
  }

  /**
   * Set minimum size threshold.
   */
  setMinimumSize(bytes: number): void {
    this.config.minSize = bytes;
  }

  /**
   * Add mime type to compression list.
   */
  addMimeType(mimeType: string): void {
    if (!this.config.mimeTypes.includes(mimeType)) {
      this.config.mimeTypes.push(mimeType);
    }
  }

  /**
   * Remove mime type from compression list.
   */
  removeMimeType(mimeType: string): void {
    this.config.mimeTypes = this.config.mimeTypes.filter((mt) => mt !== mimeType);
  }

  /**
   * Get current configuration.
   */
  getConfig(): CompressionConfig {
    return { ...this.config };
  }

  // ─── Caching ──────────────────────────────────────────────────────────────

  /**
   * Cache compressed response.
   */
  cacheCompressed(key: string, data: string): void {
    const hash = this.calculateHash(data);
    this.compressionCache.set(key, { data, hash });
  }

  /**
   * Get cached compressed data.
   */
  getCached(key: string): string | null {
    return this.compressionCache.get(key)?.data || null;
  }

  /**
   * Check if cache is valid for data.
   */
  isCacheValid(key: string, data: string): boolean {
    const cached = this.compressionCache.get(key);
    if (!cached) return false;

    const currentHash = this.calculateHash(data);
    return cached.hash === currentHash;
  }

  /**
   * Clear compression cache.
   */
  clearCache(): void {
    this.compressionCache.clear();
  }

  private calculateHash(data: string): string {
    // Simple hash function (in production, use crypto.createHash)
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  // ─── Statistics ────────────────────────────────────────────────────────────

  /**
   * Get compression statistics.
   */
  getMetrics(): {
    totalCompressions: number;
    totalOriginalSize: number;
    totalCompressedSize: number;
    averageRatio: number;
    averageTime: number;
    byAlgorithm: Record<CompressionAlgorithm, { count: number; ratio: number }>;
  } {
    let totalOriginal = 0;
    let totalCompressed = 0;
    let totalTime = 0;
    const byAlgorithm: Record<CompressionAlgorithm, { count: number; ratio: number }> = {
      gzip: { count: 0, ratio: 0 },
      brotli: { count: 0, ratio: 0 },
      deflate: { count: 0, ratio: 0 },
      none: { count: 0, ratio: 0 },
    };

    for (const metric of this.metrics) {
      totalOriginal += metric.originalSize;
      totalCompressed += metric.compressedSize;
      totalTime += metric.compressionTime;

      byAlgorithm[metric.algorithm].count++;
      byAlgorithm[metric.algorithm].ratio += metric.ratio;
    }

    // Calculate averages
    const count = this.metrics.length;
    const avgRatio = count > 0 ? totalOriginal > 0 ? ((totalOriginal - totalCompressed) / totalOriginal) * 100 : 0 : 0;
    const avgTime = count > 0 ? totalTime / count : 0;

    // Calculate per-algorithm averages
    for (const algo in byAlgorithm) {
      const algoData = byAlgorithm[algo as CompressionAlgorithm];
      if (algoData.count > 0) {
        algoData.ratio = Math.round((algoData.ratio / algoData.count) * 100) / 100;
      }
    }

    return {
      totalCompressions: count,
      totalOriginalSize: totalOriginal,
      totalCompressedSize: totalCompressed,
      averageRatio: Math.round(avgRatio * 100) / 100,
      averageTime: Math.round(avgTime * 100) / 100,
      byAlgorithm,
    };
  }

  /**
   * Get compression metrics.
   */
  getAllMetrics(): CompressionMetrics[] {
    return [...this.metrics];
  }

  /**
   * Clear metrics.
   */
  clearMetrics(): void {
    this.metrics = [];
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getCompressionCache(): Map<string, { data: string; hash: string }> {
    return this.compressionCache;
  }

  getMetricsCache(): CompressionMetrics[] {
    return this.metrics;
  }
}

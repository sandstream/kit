import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CompressionManager, type CompressionConfig } from "./compression-manager.js";

describe("CompressionManager", () => {
  describe("compression", () => {
    let manager: CompressionManager;

    beforeEach(() => {
      manager = new CompressionManager();
    });

    it("compresses data", () => {
      const data = "x".repeat(10000);
      const { metrics } = manager.compress(data);
      assert(metrics.compressedSize < metrics.originalSize);
    });

    it("returns metrics for compression", () => {
      const data = "x".repeat(10000);
      const { metrics } = manager.compress(data);
      assert(metrics.algorithm);
      assert(metrics.originalSize > 0);
      assert(metrics.ratio >= 0);
    });

    it("skips compression for small data", () => {
      const data = "small";
      const { metrics } = manager.compress(data);
      assert.equal(metrics.algorithm, "none");
      assert.equal(metrics.originalSize, metrics.compressedSize);
    });

    it("decompresses data", () => {
      const original = "test data";
      const { compressed } = manager.compress(original);
      const decompressed = manager.decompress(compressed);
      assert(decompressed.includes("test"));
    });

    it("determines if compression should occur", () => {
      const largeJson = JSON.stringify({ data: "x".repeat(5000) });
      const shouldCompress = manager.shouldCompress("application/json", largeJson.length);
      assert(shouldCompress);
    });

    it("skips compression for unsupported mime types", () => {
      const shouldCompress = manager.shouldCompress(
        "image/jpeg",
        100000,
      );
      assert(!shouldCompress);
    });

    it("skips compression for small responses", () => {
      const shouldCompress = manager.shouldCompress("application/json", 100);
      assert(!shouldCompress);
    });
  });

  describe("configuration", () => {
    let manager: CompressionManager;

    beforeEach(() => {
      manager = new CompressionManager();
    });

    it("sets compression algorithm", () => {
      manager.setAlgorithm("brotli");
      const config = manager.getConfig();
      assert.equal(config.algorithm, "brotli");
    });

    it("sets compression level", () => {
      manager.setCompressionLevel(9);
      const config = manager.getConfig();
      assert.equal(config.level, 9);
    });

    it("clamps compression level to valid range", () => {
      manager.setCompressionLevel(20);
      const config = manager.getConfig();
      assert.equal(config.level, 11);

      manager.setCompressionLevel(0);
      const config2 = manager.getConfig();
      assert.equal(config2.level, 1);
    });

    it("sets minimum size threshold", () => {
      manager.setMinimumSize(2048);
      const config = manager.getConfig();
      assert.equal(config.minSize, 2048);
    });

    it("adds mime type", () => {
      manager.addMimeType("application/custom");
      const config = manager.getConfig();
      assert(config.mimeTypes.includes("application/custom"));
    });

    it("removes mime type", () => {
      const config = manager.getConfig();
      const initialCount = config.mimeTypes.length;
      manager.removeMimeType("text/css");
      const newConfig = manager.getConfig();
      assert.equal(newConfig.mimeTypes.length, initialCount - 1);
    });

    it("uses custom configuration", () => {
      const customConfig: Partial<CompressionConfig> = {
        algorithm: "brotli",
        level: 8,
        minSize: 2048,
      };
      const customManager = new CompressionManager(customConfig);
      const config = customManager.getConfig();
      assert.equal(config.algorithm, "brotli");
      assert.equal(config.level, 8);
      assert.equal(config.minSize, 2048);
    });
  });

  describe("caching", () => {
    let manager: CompressionManager;

    beforeEach(() => {
      manager = new CompressionManager();
    });

    it("caches compressed response", () => {
      const data = "test data";
      manager.cacheCompressed("key1", data);
      const cached = manager.getCached("key1");
      assert(cached);
    });

    it("retrieves cached data", () => {
      const data = "cached content";
      manager.cacheCompressed("key1", data);
      const retrieved = manager.getCached("key1");
      assert.equal(retrieved, data);
    });

    it("returns null for uncached key", () => {
      const cached = manager.getCached("unknown");
      assert.equal(cached, null);
    });

    it("validates cache with hash", () => {
      const data = "test data";
      manager.cacheCompressed("key1", data);
      const isValid = manager.isCacheValid("key1", data);
      assert(isValid);
    });

    it("invalidates cache when data changes", () => {
      manager.cacheCompressed("key1", "original data");
      const isValid = manager.isCacheValid("key1", "modified data");
      assert(!isValid);
    });

    it("clears compression cache", () => {
      manager.cacheCompressed("key1", "data1");
      manager.cacheCompressed("key2", "data2");
      manager.clearCache();
      assert.equal(manager.getCached("key1"), null);
      assert.equal(manager.getCached("key2"), null);
    });
  });

  describe("statistics", () => {
    let manager: CompressionManager;

    beforeEach(() => {
      manager = new CompressionManager();
    });

    it("returns compression metrics", () => {
      const data = "x".repeat(10000);
      manager.compress(data);
      const metrics = manager.getMetrics();
      assert(metrics.totalCompressions > 0);
      assert(metrics.averageRatio >= 0);
    });

    it("calculates total sizes", () => {
      const data1 = "x".repeat(5000);
      const data2 = "y".repeat(8000);
      manager.compress(data1);
      manager.compress(data2);
      const metrics = manager.getMetrics();
      assert(metrics.totalOriginalSize > 0);
      assert(metrics.totalCompressedSize > 0);
    });

    it("calculates average compression ratio", () => {
      const data = "x".repeat(10000);
      manager.compress(data);
      const metrics = manager.getMetrics();
      assert(metrics.averageRatio > 0);
      assert(metrics.averageRatio <= 100);
    });

    it("calculates average compression time", () => {
      const data = "x".repeat(10000);
      manager.compress(data);
      const metrics = manager.getMetrics();
      assert(metrics.averageTime >= 0);
    });

    it("tracks metrics by algorithm", () => {
      const data = "x".repeat(10000);
      manager.setAlgorithm("gzip");
      manager.compress(data);
      const metrics = manager.getMetrics();
      assert(metrics.byAlgorithm.gzip.count > 0);
    });

    it("gets all metrics", () => {
      manager.compress("x".repeat(10000));
      manager.compress("y".repeat(5000));
      const metrics = manager.getAllMetrics();
      assert(metrics.length >= 2);
    });

    it("clears metrics", () => {
      manager.compress("x".repeat(10000));
      manager.clearMetrics();
      const metrics = manager.getMetrics();
      assert.equal(metrics.totalCompressions, 0);
    });
  });

  describe("algorithm selection", () => {
    it("uses gzip by default", () => {
      const manager = new CompressionManager();
      const config = manager.getConfig();
      assert.equal(config.algorithm, "gzip");
    });

    it("supports brotli compression", () => {
      const manager = new CompressionManager({ algorithm: "brotli" });
      const config = manager.getConfig();
      assert.equal(config.algorithm, "brotli");
    });

    it("supports deflate compression", () => {
      const manager = new CompressionManager({ algorithm: "deflate" });
      const config = manager.getConfig();
      assert.equal(config.algorithm, "deflate");
    });

    it("supports no compression", () => {
      const manager = new CompressionManager({ algorithm: "none" });
      const data = "x".repeat(10000);
      const { metrics } = manager.compress(data);
      assert.equal(metrics.algorithm, "none");
    });
  });

  describe("mime type handling", () => {
    let manager: CompressionManager;

    beforeEach(() => {
      manager = new CompressionManager();
    });

    it("compresses JSON responses", () => {
      const data = JSON.stringify({ data: "x".repeat(5000) });
      const shouldCompress = manager.shouldCompress("application/json", data.length);
      assert(shouldCompress);
    });

    it("compresses HTML responses", () => {
      const html = "<html>" + "x".repeat(5000) + "</html>";
      const shouldCompress = manager.shouldCompress("text/html", html.length);
      assert(shouldCompress);
    });

    it("compresses JavaScript responses", () => {
      const js = "const x = " + '"value"'.repeat(5000);
      const shouldCompress = manager.shouldCompress(
        "application/javascript",
        js.length,
      );
      assert(shouldCompress);
    });

    it("does not compress image responses", () => {
      const shouldCompress = manager.shouldCompress("image/png", 100000);
      assert(!shouldCompress);
    });

    it("does not compress video responses", () => {
      const shouldCompress = manager.shouldCompress("video/mp4", 100000000);
      assert(!shouldCompress);
    });
  });
});

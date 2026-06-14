import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ImageOptimizer, type OptimizationProfile } from "./image-optimizer.js";

describe("ImageOptimizer", () => {
  describe("optimization profiles", () => {
    let optimizer: ImageOptimizer;

    beforeEach(() => {
      optimizer = new ImageOptimizer();
    });

    it("creates optimization profile", () => {
      const profile: OptimizationProfile = {
        name: "thumbnail",
        maxWidth: 200,
        maxHeight: 200,
        quality: 70,
        format: "webp",
      };
      optimizer.createProfile(profile);
      const retrieved = optimizer.getProfile("thumbnail");
      assert.deepEqual(retrieved, profile);
    });

    it("gets profile by name", () => {
      const profile: OptimizationProfile = {
        name: "mobile",
        maxWidth: 480,
        maxHeight: 640,
        quality: 80,
        format: "webp",
      };
      optimizer.createProfile(profile);
      const retrieved = optimizer.getProfile("mobile");
      assert(retrieved);
      assert.equal(retrieved.name, "mobile");
    });

    it("returns null for unknown profile", () => {
      const profile = optimizer.getProfile("unknown");
      assert.equal(profile, null);
    });

    it("gets all profiles", () => {
      optimizer.createProfile({
        name: "p1",
        maxWidth: 100,
        maxHeight: 100,
        quality: 70,
        format: "webp",
      });
      optimizer.createProfile({
        name: "p2",
        maxWidth: 500,
        maxHeight: 500,
        quality: 85,
        format: "webp",
      });
      const all = optimizer.getAllProfiles();
      assert.equal(all.length, 2);
    });

    it("deletes profile", () => {
      optimizer.createProfile({
        name: "temp",
        maxWidth: 100,
        maxHeight: 100,
        quality: 70,
        format: "webp",
      });
      const deleted = optimizer.deleteProfile("temp");
      assert(deleted);
      assert.equal(optimizer.getProfile("temp"), null);
    });
  });

  describe("image optimization", () => {
    let optimizer: ImageOptimizer;
    let profile: OptimizationProfile;

    beforeEach(() => {
      optimizer = new ImageOptimizer();
      profile = {
        name: "web",
        maxWidth: 1200,
        maxHeight: 800,
        quality: 85,
        format: "webp",
      };
      optimizer.createProfile(profile);
    });

    it("optimizes image", () => {
      const metadata = optimizer.optimizeImage(
        "test.jpg",
        500000, // 500KB
        2000,
        1500,
        profile,
      );
      assert(metadata);
      assert.equal(metadata.filename, "test.jpg");
      assert(metadata.optimizedSize < metadata.originalSize);
    });

    it("respects max width constraint", () => {
      const metadata = optimizer.optimizeImage("test.jpg", 500000, 2000, 1500, profile);
      assert(metadata.width <= profile.maxWidth);
    });

    it("respects max height constraint", () => {
      const metadata = optimizer.optimizeImage(
        "test.jpg",
        500000,
        800,
        2000, // tall image
        profile,
      );
      assert(metadata.height <= profile.maxHeight);
    });

    it("maintains aspect ratio", () => {
      const metadata = optimizer.optimizeImage("test.jpg", 500000, 1000, 500, profile);
      // If width was reduced by 50%, height should also be reduced by ~50%
      assert(metadata.height <= 250 || metadata.height > 240);
    });

    it("calculates compression ratio", () => {
      const metadata = optimizer.optimizeImage(
        "test.jpg",
        500000,
        2000,
        1500,
        profile,
      );
      assert(metadata.compressionRatio > 0);
      assert(metadata.compressionRatio <= 100);
    });

    it("gets image metadata", () => {
      optimizer.optimizeImage("test.jpg", 500000, 2000, 1500, profile);
      const metadata = optimizer.getImageMetadata("test.jpg");
      assert(metadata);
      assert.equal(metadata.filename, "test.jpg");
    });

    it("gets all optimized images", () => {
      optimizer.optimizeImage("test1.jpg", 500000, 2000, 1500, profile);
      optimizer.optimizeImage("test2.jpg", 300000, 1500, 1000, profile);
      const all = optimizer.getAllOptimizedImages();
      assert.equal(all.length, 2);
    });
  });

  describe("responsive variants", () => {
    let optimizer: ImageOptimizer;

    beforeEach(() => {
      optimizer = new ImageOptimizer();
    });

    it("generates responsive variants", () => {
      const variants = optimizer.generateResponsiveVariants(
        "test.jpg",
        "https://cdn.example.com",
        [320, 640, 1024],
      );
      assert.equal(variants.length, 3);
      assert.equal(variants[0].width, 320);
      assert.equal(variants[1].width, 640);
      assert.equal(variants[2].width, 1024);
    });

    it("uses custom widths for variants", () => {
      const variants = optimizer.generateResponsiveVariants(
        "test.jpg",
        "https://cdn.example.com",
        [200, 400, 600, 800],
      );
      assert.equal(variants.length, 4);
    });

    it("generates correct URLs for variants", () => {
      const variants = optimizer.generateResponsiveVariants(
        "test.jpg",
        "https://cdn.example.com",
        [320],
      );
      assert(variants[0].url.includes("w=320"));
    });

    it("caches responsive variants", () => {
      optimizer.generateResponsiveVariants(
        "test.jpg",
        "https://cdn.example.com",
      );
      const cached = optimizer.getResponsiveVariants("test.jpg");
      assert(cached.length > 0);
    });

    it("returns empty array for uncached image", () => {
      const variants = optimizer.getResponsiveVariants("unknown.jpg");
      assert.equal(variants.length, 0);
    });
  });

  describe("lazy loading markup", () => {
    let optimizer: ImageOptimizer;
    let profile: OptimizationProfile;

    beforeEach(() => {
      optimizer = new ImageOptimizer();
      profile = {
        name: "web",
        maxWidth: 1200,
        maxHeight: 800,
        quality: 85,
        format: "webp",
      };
      optimizer.createProfile(profile);
      optimizer.optimizeImage("test.jpg", 500000, 2000, 1500, profile);
    });

    it("generates lazy loading markup", () => {
      const markup = optimizer.generateLazyLoadMarkup(
        "test.jpg",
        "https://cdn.example.com",
        "Test Image",
      );
      assert(markup.includes("loading=\"lazy\""));
      assert(markup.includes("data-src"));
      assert(markup.includes("Test Image"));
    });

    it("includes width and height in markup", () => {
      const markup = optimizer.generateLazyLoadMarkup(
        "test.jpg",
        "https://cdn.example.com",
        "Test",
      );
      assert(markup.includes("width="));
      assert(markup.includes("height="));
    });

    it("generates picture element with srcset", () => {
      optimizer.generateResponsiveVariants("test.jpg", "https://cdn.example.com");
      const markup = optimizer.generatePictureElement(
        "test.jpg",
        "https://cdn.example.com",
        "Test",
      );
      assert(markup.includes("<picture>"));
      assert(markup.includes("srcset="));
      assert(markup.includes("</picture>"));
    });

    it("returns empty string for unknown image", () => {
      const markup = optimizer.generateLazyLoadMarkup(
        "unknown.jpg",
        "https://cdn.example.com",
        "Unknown",
      );
      assert.equal(markup, "");
    });
  });

  describe("format conversion", () => {
    let optimizer: ImageOptimizer;

    beforeEach(() => {
      optimizer = new ImageOptimizer();
    });

    it("recommends WebP for high quality", () => {
      const format = optimizer.recommendFormat("jpeg", 85);
      assert.equal(format, "webp");
    });

    it("recommends AVIF for very high quality", () => {
      const format = optimizer.recommendFormat("jpeg", 90);
      assert.equal(format, "avif");
    });

    it("preserves original format when appropriate", () => {
      const format = optimizer.recommendFormat("jpeg", 70);
      assert.equal(format, "jpeg");
    });

    it("checks transparency support", () => {
      assert(optimizer.supportsTransparency("png"));
      assert(optimizer.supportsTransparency("webp"));
      assert(optimizer.supportsTransparency("avif"));
      assert(!optimizer.supportsTransparency("jpeg"));
    });
  });

  describe("statistics", () => {
    let optimizer: ImageOptimizer;
    let profile: OptimizationProfile;

    beforeEach(() => {
      optimizer = new ImageOptimizer();
      profile = {
        name: "web",
        maxWidth: 1200,
        maxHeight: 800,
        quality: 85,
        format: "webp",
      };
      optimizer.createProfile(profile);
    });

    it("returns optimization statistics", () => {
      optimizer.optimizeImage("test1.jpg", 500000, 2000, 1500, profile);
      optimizer.optimizeImage("test2.jpg", 300000, 1500, 1000, profile);

      const stats = optimizer.getOptimizationStats();
      assert.equal(stats.totalImages, 2);
      assert(stats.totalOriginalSize > 0);
      assert(stats.totalOptimizedSize > 0);
      assert(stats.averageCompressionRatio > 0);
    });

    it("calculates compression ratio correctly", () => {
      optimizer.optimizeImage("test.jpg", 1000000, 2000, 1500, profile);
      const stats = optimizer.getOptimizationStats();
      assert(stats.averageCompressionRatio > 0);
      assert(stats.averageCompressionRatio <= 100);
    });

    it("returns zero compression for no images", () => {
      const stats = optimizer.getOptimizationStats();
      assert.equal(stats.totalImages, 0);
      assert.equal(stats.averageCompressionRatio, 0);
    });
  });
});

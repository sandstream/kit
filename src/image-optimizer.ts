// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImageMetadata {
  filename: string;
  originalSize: number;
  optimizedSize: number;
  width: number;
  height: number;
  format: "jpeg" | "png" | "webp" | "avif";
  quality: number;
  compressionRatio: number;
}

export interface OptimizationProfile {
  name: string;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  format: string;
}

export interface ResponsiveVariant {
  width: number;
  height: number;
  url: string;
  size: number;
}

// ─── ImageOptimizer ───────────────────────────────────────────────────────────

export class ImageOptimizer {
  private optimizationStats: Map<string, ImageMetadata> = new Map();
  private profiles: Map<string, OptimizationProfile> = new Map();
  private thumbnailCache: Map<string, ResponsiveVariant[]> = new Map();

  // ─── Optimization Profiles ────────────────────────────────────────────────

  /**
   * Create optimization profile.
   */
  createProfile(profile: OptimizationProfile): void {
    this.profiles.set(profile.name, profile);
  }

  /**
   * Get optimization profile.
   */
  getProfile(profileName: string): OptimizationProfile | null {
    return this.profiles.get(profileName) || null;
  }

  /**
   * Get all profiles.
   */
  getAllProfiles(): OptimizationProfile[] {
    return [...this.profiles.values()];
  }

  /**
   * Delete profile.
   */
  deleteProfile(profileName: string): boolean {
    return this.profiles.delete(profileName);
  }

  // ─── Image Optimization ───────────────────────────────────────────────────

  /**
   * Optimize image.
   */
  optimizeImage(
    filename: string,
    originalSize: number,
    width: number,
    height: number,
    profile: OptimizationProfile,
  ): ImageMetadata {
    // Calculate new dimensions based on profile
    let newWidth = width;
    let newHeight = height;

    if (width > profile.maxWidth) {
      const ratio = profile.maxWidth / width;
      newWidth = profile.maxWidth;
      newHeight = Math.round(height * ratio);
    }

    if (newHeight > profile.maxHeight) {
      const ratio = profile.maxHeight / newHeight;
      newHeight = profile.maxHeight;
      newWidth = Math.round(newWidth * ratio);
    }

    // Estimate optimized size based on compression
    const optimizedSize = Math.round(originalSize * (0.5 + (profile.quality / 100) * 0.5));

    const metadata: ImageMetadata = {
      filename,
      originalSize,
      optimizedSize,
      width: newWidth,
      height: newHeight,
      format: (profile.format || "webp") as "jpeg" | "png" | "webp" | "avif",
      quality: profile.quality,
      compressionRatio: Math.round((1 - optimizedSize / originalSize) * 100),
    };

    this.optimizationStats.set(filename, metadata);
    return metadata;
  }

  /**
   * Generate responsive image variants.
   */
  generateResponsiveVariants(
    filename: string,
    baseUrl: string,
    widths: number[] = [320, 640, 1024],
  ): ResponsiveVariant[] {
    const variants: ResponsiveVariant[] = [];
    const cached = this.thumbnailCache.get(filename);

    if (cached) {
      return cached;
    }

    for (const width of widths) {
      const variant: ResponsiveVariant = {
        width,
        height: Math.round((width / 16) * 9), // 16:9 aspect ratio
        url: `${baseUrl}/${filename}?w=${width}`,
        size: Math.round(50 * (width / 320)), // Rough size estimate
      };
      variants.push(variant);
    }

    this.thumbnailCache.set(filename, variants);
    return variants;
  }

  /**
   * Get responsive variants for image.
   */
  getResponsiveVariants(filename: string): ResponsiveVariant[] {
    return this.thumbnailCache.get(filename) || [];
  }

  // ─── Lazy Loading ────────────────────────────────────────────────────────

  /**
   * Generate lazy loading markup.
   */
  generateLazyLoadMarkup(
    filename: string,
    baseUrl: string,
    alt: string,
  ): string {
    const metadata = this.optimizationStats.get(filename);
    if (!metadata) return "";

    const placeholderUrl = `${baseUrl}/${filename}?w=20&blur=5`;
    const mainUrl = `${baseUrl}/${filename}`;

    return `
<img
  src="${placeholderUrl}"
  alt="${alt}"
  width="${metadata.width}"
  height="${metadata.height}"
  loading="lazy"
  data-src="${mainUrl}"
  class="lazy-image"
/>`.trim();
  }

  /**
   * Generate picture element with srcset.
   */
  generatePictureElement(
    filename: string,
    baseUrl: string,
    alt: string,
  ): string {
    const variants = this.getResponsiveVariants(filename);
    const metadata = this.optimizationStats.get(filename);

    if (!metadata || variants.length === 0) return "";

    const srcset = variants
      .map((v) => `${v.url} ${v.width}w`)
      .join(", ");

    return `
<picture>
  <source srcset="${srcset}" type="image/webp" />
  <img
    src="${baseUrl}/${filename}"
    alt="${alt}"
    width="${metadata.width}"
    height="${metadata.height}"
    loading="lazy"
  />
</picture>`.trim();
  }

  // ─── Format Conversion ─────────────────────────────────────────────────────

  /**
   * Recommend best format for image.
   */
  recommendFormat(
    originalFormat: string,
    targetQuality: number,
  ): "webp" | "avif" | "jpeg" | "png" {
    // AVIF: better compression, newer format (highest quality first)
    if (targetQuality >= 90) return "avif";
    // WebP: good compression, broad support
    if (targetQuality >= 75) return "webp";
    // JPEG: legacy support, good quality
    if (originalFormat === "jpeg") return "jpeg";
    return "webp";
  }

  /**
   * Check if format supports transparency.
   */
  supportsTransparency(format: string): boolean {
    return ["png", "webp", "avif"].includes(format.toLowerCase());
  }

  // ─── Statistics ────────────────────────────────────────────────────────────

  /**
   * Get optimization statistics.
   */
  getOptimizationStats(): {
    totalImages: number;
    totalOriginalSize: number;
    totalOptimizedSize: number;
    averageCompressionRatio: number;
  } {
    let totalOriginal = 0;
    let totalOptimized = 0;

    for (const meta of this.optimizationStats.values()) {
      totalOriginal += meta.originalSize;
      totalOptimized += meta.optimizedSize;
    }

    const avgCompressionRatio =
      this.optimizationStats.size > 0
        ? Math.round(((totalOriginal - totalOptimized) / totalOriginal) * 100)
        : 0;

    return {
      totalImages: this.optimizationStats.size,
      totalOriginalSize: totalOriginal,
      totalOptimizedSize: totalOptimized,
      averageCompressionRatio: avgCompressionRatio,
    };
  }

  /**
   * Get metadata for image.
   */
  getImageMetadata(filename: string): ImageMetadata | null {
    return this.optimizationStats.get(filename) || null;
  }

  /**
   * Get all optimized images.
   */
  getAllOptimizedImages(): ImageMetadata[] {
    return [...this.optimizationStats.values()];
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getOptimizationCache(): Map<string, ImageMetadata> {
    return this.optimizationStats;
  }

  getProfilesCache(): Map<string, OptimizationProfile> {
    return this.profiles;
  }

  getThumbnailCache(): Map<string, ResponsiveVariant[]> {
    return this.thumbnailCache;
  }
}

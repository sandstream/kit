/**
 * kit Analytics Service
 *
 * Aggregates plugin downloads, installations, ratings, and revenue data
 * for developer dashboards and marketplace insights.
 */

export interface PluginAnalytics {
  pluginId: string;
  totalDownloads: number;
  monthlyDownloads: { month: string; downloads: number }[];
  totalInstallations: number;
  monthlyInstallations: { month: string; installations: number }[];
  rating: number;
  reviewsCount: number;
  trendingScore: number;
  uniqueInstalls: number;
  retentionRate: number;
  lastUpdated: string;
}

export interface AuthorAnalytics {
  authorId: string;
  totalEarnings: number;
  monthlyEarnings: { month: string; earnings: number }[];
  topPlugins: string[];
  totalDownloads: number;
  totalInstallations: number;
  averageRating: number;
  totalGrants: number;
  grantsFunded: number;
  createdAt: string;
  lastUpdated: string;
}

export interface RevenueMetrics {
  pluginId: string;
  period: string; // "2026-04"
  downloads: number;
  conversions: number;
  totalRevenue: number;
  authorShare: number; // 80%
  kitShare: number; // 20%
  conversionRate: number;
}

export interface DashboardMetrics {
  totalPlugins: number;
  totalDownloads: number;
  totalEarnings: number;
  activeAuthors: number;
  topPlugins: { pluginId: string; downloads: number; rating: number }[];
  revenueByMonth: { month: string; revenue: number }[];
  downloadsByCategory: { category: string; downloads: number }[];
}

/**
 * Analytics service for marketplace insights and revenue tracking
 */
export class AnalyticsService {
  private db: any;

  constructor(db?: any) {
    this.db = db;
  }

  /**
   * Get plugin analytics
   */
  async getPluginAnalytics(pluginId: string): Promise<PluginAnalytics | null> {
    const result = await this.db.query(
      `
      SELECT
        p.id,
        p.downloads,
        p.rating,
        p.reviews_count,
        p.trending_score,
        COUNT(DISTINCT pi.id) as unique_installs,
        p.last_updated
      FROM plugins p
      LEFT JOIN plugin_installations pi ON p.id = pi.plugin_id
      WHERE p.id = $1
      GROUP BY p.id, p.downloads, p.rating, p.reviews_count, p.trending_score, p.last_updated
      `,
      [pluginId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const plugin = result.rows[0];

    // Get monthly downloads
    const monthlyDownloads = await this.getMonthlyDownloads(pluginId);

    // Get monthly installations
    const monthlyInstallations = await this.getMonthlyInstallations(pluginId);

    return {
      pluginId: plugin.id,
      totalDownloads: plugin.downloads || 0,
      monthlyDownloads,
      totalInstallations: plugin.unique_installs || 0,
      monthlyInstallations,
      rating: plugin.rating || 0,
      reviewsCount: plugin.reviews_count || 0,
      trendingScore: plugin.trending_score || 0,
      uniqueInstalls: plugin.unique_installs || 0,
      retentionRate: this.calculateRetentionRate(
        plugin.unique_installs,
        plugin.downloads,
      ),
      lastUpdated: plugin.last_updated || new Date().toISOString(),
    };
  }

  /**
   * Get monthly downloads for plugin
   */
  private async getMonthlyDownloads(
    pluginId: string,
  ): Promise<{ month: string; downloads: number }[]> {
    const result = await this.db.query(
      `
      SELECT
        DATE_TRUNC('month', downloaded_at)::text as month,
        COUNT(*) as downloads
      FROM plugin_downloads
      WHERE plugin_id = $1
      GROUP BY DATE_TRUNC('month', downloaded_at)
      ORDER BY month DESC
      LIMIT 12
      `,
      [pluginId],
    );

    return result.rows.map((row: any) => ({
      month: row.month.split('T')[0],
      downloads: row.downloads,
    }));
  }

  /**
   * Get monthly installations for plugin
   */
  private async getMonthlyInstallations(
    pluginId: string,
  ): Promise<{ month: string; installations: number }[]> {
    const result = await this.db.query(
      `
      SELECT
        DATE_TRUNC('month', installed_at)::text as month,
        COUNT(*) as installations
      FROM plugin_installations
      WHERE plugin_id = $1
      GROUP BY DATE_TRUNC('month', installed_at)
      ORDER BY month DESC
      LIMIT 12
      `,
      [pluginId],
    );

    return result.rows.map((row: any) => ({
      month: row.month.split('T')[0],
      installations: row.installations,
    }));
  }

  /**
   * Calculate retention rate (installations/downloads ratio)
   */
  private calculateRetentionRate(installations: number, downloads: number): number {
    if (downloads === 0) return 0;
    return (installations / downloads) * 100;
  }

  /**
   * Get author analytics
   */
  async getAuthorAnalytics(authorId: string): Promise<AuthorAnalytics | null> {
    const result = await this.db.query(
      `
      SELECT
        a.id,
        a.name,
        COUNT(DISTINCT p.id) as total_plugins,
        SUM(p.downloads) as total_downloads,
        COUNT(DISTINCT pi.id) as total_installations,
        AVG(p.rating) as avg_rating,
        COALESCE(pr.total_earnings, 0) as total_earnings,
        a.created_at
      FROM authors a
      LEFT JOIN plugins p ON a.id = p.author_id
      LEFT JOIN plugin_installations pi ON p.id = pi.plugin_id
      LEFT JOIN (
        SELECT
          author_id,
          SUM(author_earnings) as total_earnings
        FROM plugin_revenue
        GROUP BY author_id
      ) pr ON a.id = pr.author_id
      WHERE a.id = $1
      GROUP BY a.id, a.name, a.created_at, pr.total_earnings
      `,
      [authorId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const author = result.rows[0];

    // Get top plugins by downloads
    const topPlugins = await this.getAuthorTopPlugins(authorId, 5);

    // Get monthly earnings
    const monthlyEarnings = await this.getMonthlyEarnings(authorId);

    return {
      authorId: author.id,
      totalEarnings: parseFloat(author.total_earnings) || 0,
      monthlyEarnings,
      topPlugins,
      totalDownloads: author.total_downloads || 0,
      totalInstallations: author.total_installations || 0,
      averageRating: parseFloat(author.avg_rating) || 0,
      totalGrants: 0, // From grant_applications table
      grantsFunded: 0, // From grant_applications where status='approved'
      createdAt: author.created_at,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Get author's top plugins by downloads
   */
  private async getAuthorTopPlugins(
    authorId: string,
    limit: number = 5,
  ): Promise<string[]> {
    const result = await this.db.query(
      `
      SELECT id FROM plugins
      WHERE author_id = $1
      ORDER BY downloads DESC
      LIMIT $2
      `,
      [authorId, limit],
    );

    return result.rows.map((row: any) => row.id);
  }

  /**
   * Get monthly earnings for author
   */
  private async getMonthlyEarnings(
    authorId: string,
  ): Promise<{ month: string; earnings: number }[]> {
    const result = await this.db.query(
      `
      SELECT
        DATE_TRUNC('month', period)::text as month,
        SUM(author_earnings) as earnings
      FROM plugin_revenue
      WHERE (
        SELECT author_id FROM plugins WHERE id = plugin_id
      ) = $1
      GROUP BY DATE_TRUNC('month', period)
      ORDER BY month DESC
      LIMIT 12
      `,
      [authorId],
    );

    return result.rows.map((row: any) => ({
      month: row.month.split('T')[0],
      earnings: parseFloat(row.earnings) || 0,
    }));
  }

  /**
   * Get revenue metrics for plugin
   */
  async getPluginRevenueMetrics(pluginId: string): Promise<RevenueMetrics[]> {
    const result = await this.db.query(
      `
      SELECT
        plugin_id,
        period,
        downloads,
        conversions,
        (downloads * 0.5) as total_revenue,
        (downloads * 0.5 * 0.8) as author_share,
        (downloads * 0.5 * 0.2) as kit_share,
        CASE WHEN downloads > 0 THEN (conversions::float / downloads) ELSE 0 END as conversion_rate
      FROM plugin_revenue
      WHERE plugin_id = $1
      ORDER BY period DESC
      LIMIT 12
      `,
      [pluginId],
    );

    return result.rows.map((row: any) => ({
      pluginId: row.plugin_id,
      period: row.period,
      downloads: row.downloads,
      conversions: row.conversions,
      totalRevenue: parseFloat(row.total_revenue) || 0,
      authorShare: parseFloat(row.author_share) || 0,
      kitShare: parseFloat(row.kit_share) || 0,
      conversionRate: parseFloat(row.conversion_rate) || 0,
    }));
  }

  /**
   * Get dashboard metrics (admin view)
   */
  async getDashboardMetrics(): Promise<DashboardMetrics> {
    // Total plugins
    const pluginsResult = await this.db.query(
      `SELECT COUNT(*) as count FROM plugins`,
    );
    const totalPlugins = pluginsResult.rows[0]?.count || 0;

    // Total downloads
    const downloadsResult = await this.db.query(
      `SELECT SUM(downloads) as total FROM plugins`,
    );
    const totalDownloads = parseInt(downloadsResult.rows[0]?.total) || 0;

    // Total earnings
    const earningsResult = await this.db.query(
      `SELECT SUM(author_earnings) as total FROM plugin_revenue`,
    );
    const totalEarnings = parseFloat(earningsResult.rows[0]?.total) || 0;

    // Active authors
    const authorsResult = await this.db.query(
      `SELECT COUNT(DISTINCT author_id) as count FROM plugins`,
    );
    const activeAuthors = authorsResult.rows[0]?.count || 0;

    // Top plugins
    const topPluginsResult = await this.db.query(
      `SELECT id, downloads, rating FROM plugins ORDER BY downloads DESC LIMIT 5`,
    );
    const topPlugins = topPluginsResult.rows || [];

    // Revenue by month
    const revenueResult = await this.db.query(
      `
      SELECT
        period as month,
        SUM(author_earnings + kit_commission) as revenue
      FROM plugin_revenue
      GROUP BY period
      ORDER BY month DESC
      LIMIT 12
      `,
    );
    const revenueByMonth = (revenueResult.rows || []).map((row: any) => ({
      month: row.month,
      revenue: parseFloat(row.revenue) || 0,
    }));

    // Downloads by category (from tags)
    const categoryResult = await this.db.query(
      `
      SELECT
        tag,
        SUM(downloads) as downloads
      FROM plugin_tags pt
      JOIN plugins p ON pt.plugin_id = p.id
      GROUP BY tag
      ORDER BY downloads DESC
      LIMIT 10
      `,
    );
    const downloadsByCategory = (categoryResult.rows || []).map((row: any) => ({
      category: row.tag,
      downloads: row.downloads,
    }));

    return {
      totalPlugins,
      totalDownloads,
      totalEarnings,
      activeAuthors,
      topPlugins: topPlugins.map((p: any) => ({
        pluginId: p.id,
        downloads: p.downloads,
        rating: p.rating,
      })),
      revenueByMonth,
      downloadsByCategory,
    };
  }

  /**
   * Get trending plugins (by recent downloads)
   */
  async getTrendingPlugins(limit: number = 10): Promise<PluginAnalytics[]> {
    const result = await this.db.query(
      `
      SELECT id FROM plugins
      ORDER BY trending_score DESC, downloads DESC
      LIMIT $1
      `,
      [limit],
    );

    const plugins: PluginAnalytics[] = [];
    for (const row of result.rows) {
      const analytics = await this.getPluginAnalytics(row.id);
      if (analytics) {
        plugins.push(analytics);
      }
    }
    return plugins;
  }

  /**
   * Search analytics by date range
   */
  async getAnalyticsByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    downloads: number;
    installations: number;
    revenue: number;
    authors: number;
  }> {
    const result = await this.db.query(
      `
      SELECT
        COUNT(DISTINCT d.plugin_id) as unique_downloads,
        COUNT(DISTINCT i.id) as unique_installations,
        COALESCE(SUM(pr.total_earnings), 0) as total_revenue,
        COUNT(DISTINCT p.author_id) as unique_authors
      FROM plugin_downloads d
      FULL OUTER JOIN plugin_installations i ON d.plugin_id = i.plugin_id
      LEFT JOIN plugins p ON d.plugin_id = p.id OR i.plugin_id = p.id
      LEFT JOIN plugin_revenue pr ON p.id = pr.plugin_id
      WHERE (d.downloaded_at BETWEEN $1 AND $2 OR i.installed_at BETWEEN $1 AND $2)
      `,
      [startDate.toISOString(), endDate.toISOString()],
    );

    const row = result.rows[0];
    return {
      downloads: row.unique_downloads || 0,
      installations: row.unique_installations || 0,
      revenue: parseFloat(row.total_revenue) || 0,
      authors: row.unique_authors || 0,
    };
  }
}

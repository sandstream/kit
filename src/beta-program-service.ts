/**
 * kit Beta Program Service
 *
 * Manages community developer beta enrollment, feedback collection, and certification
 * refinement based on real-world plugin usage patterns.
 */

import { IdGenerators } from "./id-generator.js";

export interface BetaDeveloper {
  id: string;
  email: string;
  name: string;
  organization?: string;
  enrolledAt: string;
  status: "active" | "inactive" | "churned";
  pluginsTested: string[];
  feedbackCount: number;
  lastActivityAt?: string;
}

export interface PluginFeedback {
  id: string;
  pluginId: string;
  developerId: string;
  rating: number; // 1-5
  category: "usability" | "stability" | "performance" | "documentation" | "feature-request" | "bug";
  title: string;
  description: string;
  severity?: "low" | "medium" | "high" | "critical";
  status: "open" | "acknowledged" | "addressed" | "wontfix";
  createdAt: string;
  updatedAt: string;
}

export interface CertificationRefinement {
  id: string;
  category: string;
  description: string;
  feedbackCount: number;
  severity: "informational" | "warning" | "critical";
  status: "proposed" | "under-review" | "approved" | "implemented";
  affectedPlugins: string[];
  createdAt: string;
  implementedAt?: string;
}

export interface BetaProgram {
  id: string;
  name: string;
  targetDevelopers: number;
  enrolledDevelopers: number;
  status: "recruiting" | "active" | "closed";
  startDate: string;
  endDate?: string;
  feedbackItems: number;
  refinementsProposed: number;
}

/**
 * Beta program management service
 */
export class BetaProgramService {
  private db: any;

  constructor(db?: any) {
    this.db = db;
  }

  /**
   * Enroll developer in beta program
   */
  async enrollDeveloper(
    email: string,
    name: string,
    organization?: string,
  ): Promise<BetaDeveloper> {
    const id = IdGenerators.betaDev();
    const result = await this.db.query(
      `
      INSERT INTO beta_developers (id, email, name, organization, enrolled_at, status)
      VALUES ($1, $2, $3, $4, now(), $5)
      RETURNING *
      `,
      [id, email, name, organization || null, "active"],
    );

    return this.mapBetaDeveloper(result.rows[0]);
  }

  /**
   * Submit feedback on plugin
   */
  async submitFeedback(
    pluginId: string,
    developerId: string,
    rating: number,
    category: string,
    title: string,
    description: string,
    severity?: string,
  ): Promise<PluginFeedback> {
    if (rating < 1 || rating > 5) {
      throw new Error("Rating must be between 1 and 5");
    }

    const id = IdGenerators.feedback();
    const result = await this.db.query(
      `
      INSERT INTO plugin_feedback
      (id, plugin_id, developer_id, rating, category, title, description, severity, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
      RETURNING *
      `,
      [id, pluginId, developerId, rating, category, title, description, severity || "medium", "open"],
    );

    // Update developer activity
    await this.db.query(
      `
      UPDATE beta_developers
      SET last_activity_at = now()
      WHERE id = $1
      `,
      [developerId],
    );

    return this.mapPluginFeedback(result.rows[0]);
  }

  /**
   * Get feedback for plugin
   */
  async getPluginFeedback(pluginId: string): Promise<PluginFeedback[]> {
    const result = await this.db.query(
      `
      SELECT * FROM plugin_feedback
      WHERE plugin_id = $1
      ORDER BY created_at DESC
      `,
      [pluginId],
    );

    return result.rows.map((row: any) => this.mapPluginFeedback(row));
  }

  /**
   * Get developer feedback history
   */
  async getDeveloperFeedback(developerId: string): Promise<PluginFeedback[]> {
    const result = await this.db.query(
      `
      SELECT * FROM plugin_feedback
      WHERE developer_id = $1
      ORDER BY created_at DESC
      `,
      [developerId],
    );

    return result.rows.map((row: any) => this.mapPluginFeedback(row));
  }

  /**
   * Aggregate feedback to identify certification refinements
   */
  async identifyRefinements(): Promise<CertificationRefinement[]> {
    const result = await this.db.query(
      `
      SELECT
        category,
        severity,
        COUNT(*) as feedback_count,
        ARRAY_AGG(DISTINCT plugin_id) as affected_plugins
      FROM plugin_feedback
      WHERE status = $1 AND severity IN ($2, $3, $4)
      GROUP BY category, severity
      HAVING COUNT(*) >= 3
      ORDER BY feedback_count DESC
      `,
      ["open", "medium", "high", "critical"],
    );

    const refinements: CertificationRefinement[] = [];
    for (const row of result.rows) {
      refinements.push({
        id: IdGenerators.refine(),
        category: row.category,
        description: `${row.feedback_count} developers reported issues with ${row.category}`,
        feedbackCount: row.feedback_count,
        severity: row.severity,
        status: "proposed",
        affectedPlugins: row.affected_plugins || [],
        createdAt: new Date().toISOString(),
      });
    }

    return refinements;
  }

  /**
   * Get beta program status
   */
  async getBetaProgramStatus(): Promise<BetaProgram> {
    // Active program
    const devResult = await this.db.query(
      `
      SELECT COUNT(*) as enrolled FROM beta_developers WHERE status = $1
      `,
      ["active"],
    );

    const feedbackResult = await this.db.query(
      `
      SELECT COUNT(*) as total FROM plugin_feedback
      `,
    );

    const refinementResult = await this.db.query(
      `
      SELECT COUNT(*) as total FROM certification_refinements WHERE status = $1
      `,
      ["proposed"],
    );

    return {
      id: "beta-main-2026",
      name: "kit Community Beta Launch",
      targetDevelopers: 20,
      enrolledDevelopers: devResult.rows[0]?.enrolled || 0,
      status: "active",
      startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 1 week ago
      feedbackItems: feedbackResult.rows[0]?.total || 0,
      refinementsProposed: refinementResult.rows[0]?.total || 0,
    };
  }

  /**
   * Get developer profile with feedback summary
   */
  async getDeveloperProfile(developerId: string): Promise<BetaDeveloper | null> {
    const result = await this.db.query(
      `
      SELECT
        bd.*,
        COUNT(DISTINCT pf.id) as feedback_count,
        ARRAY_AGG(DISTINCT pf.plugin_id) as plugins_tested
      FROM beta_developers bd
      LEFT JOIN plugin_feedback pf ON bd.id = pf.developer_id
      WHERE bd.id = $1
      GROUP BY bd.id
      `,
      [developerId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      organization: row.organization,
      enrolledAt: row.enrolled_at,
      status: row.status,
      pluginsTested: row.plugins_tested || [],
      feedbackCount: row.feedback_count || 0,
      lastActivityAt: row.last_activity_at,
    };
  }

  /**
   * Get beta developers
   */
  async getBetaDevelopers(limit: number = 50): Promise<BetaDeveloper[]> {
    const result = await this.db.query(
      `
      SELECT * FROM beta_developers
      WHERE status = $1
      ORDER BY last_activity_at DESC
      LIMIT $2
      `,
      ["active", limit],
    );

    return result.rows.map((row: any) => this.mapBetaDeveloper(row));
  }

  /**
   * Update feedback status
   */
  async updateFeedbackStatus(feedbackId: string, status: string): Promise<void> {
    await this.db.query(
      `
      UPDATE plugin_feedback
      SET status = $1, updated_at = now()
      WHERE id = $2
      `,
      [status, feedbackId],
    );
  }

  /**
   * Get feedback analytics
   */
  async getFeedbackAnalytics(): Promise<{
    totalFeedback: number;
    byCategory: { category: string; count: number }[];
    bySeverity: { severity: string; count: number }[];
    avgRating: number;
  }> {
    const totalResult = await this.db.query(`SELECT COUNT(*) as total FROM plugin_feedback`);

    const categoryResult = await this.db.query(
      `
      SELECT category, COUNT(*) as count
      FROM plugin_feedback
      GROUP BY category
      ORDER BY count DESC
      `,
    );

    const severityResult = await this.db.query(
      `
      SELECT severity, COUNT(*) as count
      FROM plugin_feedback
      GROUP BY severity
      ORDER BY count DESC
      `,
    );

    const ratingResult = await this.db.query(`SELECT AVG(rating) as avg FROM plugin_feedback`);

    return {
      totalFeedback: totalResult.rows[0]?.total || 0,
      byCategory: categoryResult.rows.map((row: any) => ({
        category: row.category,
        count: row.count,
      })),
      bySeverity: severityResult.rows.map((row: any) => ({
        severity: row.severity,
        count: row.count,
      })),
      avgRating: parseFloat(ratingResult.rows[0]?.avg) || 0,
    };
  }

  private mapBetaDeveloper(row: any): BetaDeveloper {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      organization: row.organization,
      enrolledAt: row.enrolled_at,
      status: row.status,
      pluginsTested: row.plugins_tested || [],
      feedbackCount: row.feedback_count || 0,
      lastActivityAt: row.last_activity_at,
    };
  }

  private mapPluginFeedback(row: any): PluginFeedback {
    return {
      id: row.id,
      pluginId: row.plugin_id,
      developerId: row.developer_id,
      rating: row.rating,
      category: row.category,
      title: row.title,
      description: row.description,
      severity: row.severity,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

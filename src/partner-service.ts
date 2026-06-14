/**
 * kit Partner Service
 *
 * Manages partner enrollment, API key generation, and co-developed plugin partnerships
 */

import { IdGenerators } from "./id-generator.js";

/**
 * Partner profile with tier and API access
 */
export interface PartnerProfile {
  authorId: string;
  partnerTier?: "bronze" | "silver" | "gold" | "platinum";
  organizationType?: "startup" | "enterprise" | "agency" | "consulting";
  agreementSignedAt?: string;
  agreementVersion?: string;
  apiKey?: string;
  webhookUrl?: string;
  rateLimit: number;
}

/**
 * API key with encrypted secret
 */
export interface PartnerApiKey {
  id: string;
  authorId: string;
  apiKey: string;
  createdAt: string;
  rotatedAt?: string;
  lastUsedAt?: string;
}

/**
 * Co-developed plugin partnership
 */
export interface CoDevelopedPlugin {
  id: string;
  pluginId: string;
  partnerAuthorId: string;
  primaryAuthorId: string;
  revenueSplit: string; // "50-50", "60-40", etc
  approvalStatus: "pending" | "approved" | "rejected";
  approvedBy?: string;
  approvalDate?: string;
  createdAt: string;
}

/**
 * Partner service for managing partnerships and integrations
 */
export class PartnerService {
  private db: any;

  constructor(db?: any) {
    this.db = db;
  }

  /**
   * Enroll author as partner
   */
  async enrollAsPartner(
    authorId: string,
    tier: "bronze" | "silver" | "gold" | "platinum",
    organizationType: "startup" | "enterprise" | "agency" | "consulting",
  ): Promise<PartnerProfile> {
    const result = await this.db.query(
      `
      UPDATE authors
      SET partner_tier = $1, partner_organization_type = $2, partner_rate_limit = $3
      WHERE id = $4
      RETURNING *
      `,
      [tier, organizationType, 1000, authorId],
    );

    return this.mapPartnerProfile(result.rows[0]);
  }

  /**
   * Sign partner agreement
   */
  async signPartnerAgreement(
    authorId: string,
    tier: string,
    version: string,
  ): Promise<void> {
    const id = IdGenerators.agreement();
    await this.db.query(
      `
      INSERT INTO partnership_agreements
      (id, author_id, tier, version, signed_at, signed_by, created_at)
      VALUES ($1, $2, $3, $4, now(), $5, now())
      `,
      [id, authorId, tier, version, authorId],
    );

    await this.db.query(
      `
      UPDATE authors
      SET partner_agreement_signed_at = now(), partner_agreement_version = $1
      WHERE id = $2
      `,
      [version, authorId],
    );
  }

  /**
   * Generate API key for partner
   */
  async generateApiKey(authorId: string): Promise<PartnerApiKey> {
    const apiKey = `pk_${IdGenerators.apiKey().slice(0, 32)}`;
    const secretKey = IdGenerators.apiKey();

    const id = IdGenerators.apiKey();
    const result = await this.db.query(
      `
      INSERT INTO partner_api_keys
      (id, author_id, api_key, secret_key, created_at)
      VALUES ($1, $2, $3, $4, now())
      RETURNING id, author_id, api_key, created_at
      `,
      [id, authorId, apiKey, secretKey],
    );

    return {
      id: result.rows[0].id,
      authorId: result.rows[0].author_id,
      apiKey: result.rows[0].api_key,
      createdAt: result.rows[0].created_at,
    };
  }

  /**
   * Validate API key and check rate limits
   */
  async validateApiKey(apiKey: string): Promise<PartnerProfile | null> {
    const result = await this.db.query(
      `
      SELECT a.* FROM authors a
      JOIN partner_api_keys pk ON a.id = pk.author_id
      WHERE pk.api_key = $1
      `,
      [apiKey],
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Update last_used_at
    await this.db.query(
      `
      UPDATE partner_api_keys
      SET last_used_at = now()
      WHERE api_key = $1
      `,
      [apiKey],
    );

    return this.mapPartnerProfile(result.rows[0]);
  }

  /**
   * Rotate API key
   */
  async rotateApiKey(authorId: string): Promise<PartnerApiKey> {
    // Get old key
    const oldKey = await this.db.query(
      `
      SELECT * FROM partner_api_keys WHERE author_id = $1
      `,
      [authorId],
    );

    if (oldKey.rows.length === 0) {
      throw new Error("No API key found");
    }

    // Delete old key
    await this.db.query(
      `
      DELETE FROM partner_api_keys WHERE author_id = $1
      `,
      [authorId],
    );

    // Generate new key
    return this.generateApiKey(authorId);
  }

  /**
   * Get partner profile
   */
  async getPartnerProfile(authorId: string): Promise<PartnerProfile | null> {
    const result = await this.db.query(
      `
      SELECT * FROM authors WHERE id = $1
      `,
      [authorId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapPartnerProfile(result.rows[0]);
  }

  /**
   * Create co-developed plugin partnership
   */
  async createCoDevelopedPlugin(
    pluginId: string,
    partnerAuthorId: string,
    primaryAuthorId: string,
    revenueSplit: string,
  ): Promise<CoDevelopedPlugin> {
    const id = IdGenerators.coPlugin();
    const result = await this.db.query(
      `
      INSERT INTO co_developed_plugins
      (id, plugin_id, partner_author_id, primary_author_id, revenue_split, approval_status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      RETURNING *
      `,
      [id, pluginId, partnerAuthorId, primaryAuthorId, revenueSplit, "pending"],
    );

    return this.mapCoDevelopedPlugin(result.rows[0]);
  }

  /**
   * Approve co-developed plugin
   */
  async approveCoDevelopedPlugin(
    coDevelopedId: string,
    approvedBy: string,
  ): Promise<CoDevelopedPlugin> {
    const result = await this.db.query(
      `
      UPDATE co_developed_plugins
      SET approval_status = $1, approved_by = $2, approval_date = now()
      WHERE id = $3
      RETURNING *
      `,
      ["approved", approvedBy, coDevelopedId],
    );

    return this.mapCoDevelopedPlugin(result.rows[0]);
  }

  /**
   * Get co-developed plugins by partner
   */
  async getPartnerCoDevelopedPlugins(
    authorId: string,
  ): Promise<CoDevelopedPlugin[]> {
    const result = await this.db.query(
      `
      SELECT * FROM co_developed_plugins
      WHERE partner_author_id = $1 OR primary_author_id = $1
      ORDER BY created_at DESC
      `,
      [authorId],
    );

    return result.rows.map((row: any) => this.mapCoDevelopedPlugin(row));
  }

  /**
   * Calculate partner revenue share
   */
  calculatePartnerShare(
    totalRevenue: number,
    revenueSplit: string,
  ): { partnerShare: number; primaryShare: number } {
    const [partner, primary] = revenueSplit.split("-").map(Number);
    const total = partner + primary;

    return {
      partnerShare: (totalRevenue * partner) / total,
      primaryShare: (totalRevenue * primary) / total,
    };
  }

  /**
   * Map database row to PartnerProfile
   */
  private mapPartnerProfile(row: any): PartnerProfile {
    return {
      authorId: row.id,
      partnerTier: row.partner_tier,
      organizationType: row.partner_organization_type,
      agreementSignedAt: row.partner_agreement_signed_at,
      agreementVersion: row.partner_agreement_version,
      webhookUrl: row.partner_webhook_url,
      rateLimit: row.partner_rate_limit || 1000,
    };
  }

  /**
   * Map database row to CoDevelopedPlugin
   */
  private mapCoDevelopedPlugin(row: any): CoDevelopedPlugin {
    return {
      id: row.id,
      pluginId: row.plugin_id,
      partnerAuthorId: row.partner_author_id,
      primaryAuthorId: row.primary_author_id,
      revenueSplit: row.revenue_split,
      approvalStatus: row.approval_status,
      approvedBy: row.approved_by,
      approvalDate: row.approval_date,
      createdAt: row.created_at,
    };
  }
}

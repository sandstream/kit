// ─── Database Migration Definitions ───────────────────────────────────────────

import { type Migration } from "./database.js";

/**
 * All database migrations for kit marketplace.
 * Execute in order by version number.
 */
export const MIGRATIONS: Migration[] = [
  // ─── Phase 1: Core Tables ──────────────────────────────────────────────
  {
    id: "001-create-plugins",
    name: "Create plugins table",
    version: "1.0.0",
    sql: `
      CREATE TABLE IF NOT EXISTS plugins (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        author VARCHAR(255) NOT NULL,
        version VARCHAR(20) NOT NULL,
        rating DECIMAL(3,1) DEFAULT 0,
        downloads INTEGER DEFAULT 0,
        verified BOOLEAN DEFAULT FALSE,
        official BOOLEAN DEFAULT FALSE,
        categories TEXT[] DEFAULT ARRAY[]::TEXT[],
        tags TEXT[] DEFAULT ARRAY[]::TEXT[],
        repository_url VARCHAR(255),
        license VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_author (author),
        INDEX idx_name (name),
        INDEX idx_rating (rating)
      )
    `,
  },

  {
    id: "002-create-authors",
    name: "Create authors table",
    version: "1.0.0",
    sql: `
      CREATE TABLE IF NOT EXISTS authors (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        bio TEXT,
        avatar_url VARCHAR(255),
        verified BOOLEAN DEFAULT FALSE,
        plugin_count INTEGER DEFAULT 0,
        total_downloads INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_name (name),
        INDEX idx_verified (verified)
      )
    `,
  },

  {
    id: "003-create-reviews",
    name: "Create reviews table",
    version: "1.0.0",
    sql: `
      CREATE TABLE IF NOT EXISTS reviews (
        id VARCHAR(255) PRIMARY KEY,
        plugin_id VARCHAR(255) NOT NULL,
        author_id VARCHAR(255) NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT,
        helpful_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plugin_id) REFERENCES plugins(id),
        FOREIGN KEY (author_id) REFERENCES authors(id),
        INDEX idx_plugin_id (plugin_id),
        INDEX idx_author_id (author_id),
        INDEX idx_rating (rating)
      )
    `,
  },

  // ─── Phase 2: Analytics & Tracking ────────────────────────────────────
  {
    id: "004-create-plugin-analytics",
    name: "Create plugin analytics table",
    version: "1.1.0",
    sql: `
      CREATE TABLE IF NOT EXISTS plugin_analytics (
        id VARCHAR(255) PRIMARY KEY,
        plugin_id VARCHAR(255) NOT NULL,
        date DATE NOT NULL,
        downloads INTEGER DEFAULT 0,
        views INTEGER DEFAULT 0,
        installs INTEGER DEFAULT 0,
        uninstalls INTEGER DEFAULT 0,
        average_rating DECIMAL(3,1),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plugin_id) REFERENCES plugins(id),
        INDEX idx_plugin_date (plugin_id, date)
      )
    `,
  },

  {
    id: "005-create-search-logs",
    name: "Create search logs table",
    version: "1.1.0",
    sql: `
      CREATE TABLE IF NOT EXISTS search_logs (
        id VARCHAR(255) PRIMARY KEY,
        query VARCHAR(255) NOT NULL,
        result_count INTEGER DEFAULT 0,
        user_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_query (query),
        INDEX idx_created_at (created_at)
      )
    `,
  },

  // ─── Phase 3: Publishing & CI/CD ───────────────────────────────────────
  {
    id: "006-create-publish-plans",
    name: "Create publish plans table",
    version: "1.2.0",
    sql: `
      CREATE TABLE IF NOT EXISTS publish_plans (
        id VARCHAR(255) PRIMARY KEY,
        plugin_id VARCHAR(255) NOT NULL,
        version VARCHAR(20) NOT NULL,
        status VARCHAR(50) NOT NULL,
        trigger_type VARCHAR(50),
        requires_approval BOOLEAN DEFAULT FALSE,
        changelog TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plugin_id) REFERENCES plugins(id),
        INDEX idx_plugin_id (plugin_id),
        INDEX idx_status (status)
      )
    `,
  },

  {
    id: "007-create-approvals",
    name: "Create approvals table",
    version: "1.2.0",
    sql: `
      CREATE TABLE IF NOT EXISTS approvals (
        id VARCHAR(255) PRIMARY KEY,
        publish_plan_id VARCHAR(255) NOT NULL,
        approved_by VARCHAR(255) NOT NULL,
        approved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        comment TEXT,
        FOREIGN KEY (publish_plan_id) REFERENCES publish_plans(id),
        INDEX idx_publish_plan_id (publish_plan_id)
      )
    `,
  },

  // ─── Phase 4: Security & Monitoring ────────────────────────────────────
  {
    id: "008-create-security-logs",
    name: "Create security audit logs table",
    version: "1.3.0",
    sql: `
      CREATE TABLE IF NOT EXISTS security_logs (
        id VARCHAR(255) PRIMARY KEY,
        action VARCHAR(100) NOT NULL,
        actor VARCHAR(255),
        resource VARCHAR(255),
        status VARCHAR(50) NOT NULL,
        details JSONB,
        ip_address INET,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_action (action),
        INDEX idx_actor (actor),
        INDEX idx_created_at (created_at)
      )
    `,
  },

  {
    id: "009-create-error_logs",
    name: "Create error logs table",
    version: "1.3.0",
    sql: `
      CREATE TABLE IF NOT EXISTS error_logs (
        id VARCHAR(255) PRIMARY KEY,
        message VARCHAR(255) NOT NULL,
        stack TEXT,
        severity VARCHAR(20) NOT NULL,
        context JSONB,
        user_id VARCHAR(255),
        session_id VARCHAR(255),
        resolved BOOLEAN DEFAULT FALSE,
        resolved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_message (message),
        INDEX idx_severity (severity),
        INDEX idx_created_at (created_at)
      )
    `,
  },

  {
    id: "010-create-sla_objectives",
    name: "Create SLA objectives table",
    version: "1.3.0",
    sql: `
      CREATE TABLE IF NOT EXISTS sla_objectives (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        metric VARCHAR(50) NOT NULL,
        target DECIMAL(10,2) NOT NULL,
        threshold DECIMAL(10,2) NOT NULL,
        unit VARCHAR(20),
        window VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_name (name),
        INDEX idx_metric (metric)
      )
    `,
  },

  {
    id: "011-create-sla_measurements",
    name: "Create SLA measurements table",
    version: "1.3.0",
    sql: `
      CREATE TABLE IF NOT EXISTS sla_measurements (
        id VARCHAR(255) PRIMARY KEY,
        sla_id VARCHAR(255) NOT NULL,
        value DECIMAL(10,2) NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sla_id) REFERENCES sla_objectives(id),
        INDEX idx_sla_id (sla_id),
        INDEX idx_timestamp (timestamp)
      )
    `,
  },

  // ─── Phase 5: Notifications & Communication ────────────────────────────
  {
    id: "012-create-notifications",
    name: "Create notifications table",
    version: "1.4.0",
    sql: `
      CREATE TABLE IF NOT EXISTS notifications (
        id VARCHAR(255) PRIMARY KEY,
        author_id VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        subject VARCHAR(255),
        message TEXT,
        read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES authors(id),
        INDEX idx_author_id (author_id),
        INDEX idx_read (read),
        INDEX idx_created_at (created_at)
      )
    `,
  },

  // ─── Phase 6: Caching & Performance ────────────────────────────────────
  {
    id: "013-create-cache_entries",
    name: "Create cache entries table",
    version: "1.5.0",
    sql: `
      CREATE TABLE IF NOT EXISTS cache_entries (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        ttl INTEGER,
        hits INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        INDEX idx_expires_at (expires_at),
        INDEX idx_created_at (created_at)
      )
    `,
  },

  // ─── Performance Indexes ───────────────────────────────────────────────
  {
    id: "014-create-performance-indexes",
    name: "Create performance indexes",
    version: "1.5.0",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_plugins_search ON plugins
      USING GIN(to_tsvector('english', name || ' ' || description));

      CREATE INDEX IF NOT EXISTS idx_reviews_plugin_rating
      ON reviews(plugin_id, rating DESC);

      CREATE INDEX IF NOT EXISTS idx_analytics_plugin_date
      ON plugin_analytics(plugin_id, date DESC);
    `,
  },

  // ─── Aggregate Views ───────────────────────────────────────────────────
  {
    id: "015-create-materialized-views",
    name: "Create materialized views",
    version: "1.5.0",
    sql: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS plugin_stats AS
      SELECT
        p.id,
        p.name,
        COUNT(DISTINCT r.id) as review_count,
        AVG(r.rating) as avg_rating,
        COALESCE(SUM(pa.downloads), 0) as total_downloads,
        MAX(pa.date) as last_tracked_date
      FROM plugins p
      LEFT JOIN reviews r ON p.id = r.plugin_id
      LEFT JOIN plugin_analytics pa ON p.id = pa.plugin_id
      GROUP BY p.id, p.name;

      CREATE INDEX idx_plugin_stats_id ON plugin_stats(id);
    `,
  },

  // ─── Phase 7: Payments & Monetization ──────────────────────────────────
  {
    id: "016-create-author-payout-accounts",
    name: "Create author payout accounts table",
    version: "2.0.0",
    sql: `
      CREATE TABLE IF NOT EXISTS author_payout_accounts (
        id VARCHAR(255) PRIMARY KEY,
        author_id VARCHAR(255) NOT NULL UNIQUE,
        stripe_account_id VARCHAR(255) UNIQUE,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        kyc_status VARCHAR(50) DEFAULT 'pending',
        tax_id TEXT,
        bank_account_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES authors(id),
        INDEX idx_author_id (author_id),
        INDEX idx_status (status),
        INDEX idx_kyc_status (kyc_status)
      )
    `,
  },

  {
    id: "017-create-plugin-revenue",
    name: "Create plugin revenue tracking table",
    version: "2.0.0",
    sql: `
      CREATE TABLE IF NOT EXISTS plugin_revenue (
        id VARCHAR(255) PRIMARY KEY,
        plugin_id VARCHAR(255) NOT NULL UNIQUE,
        author_id VARCHAR(255) NOT NULL,
        gross_revenue DECIMAL(12,2) DEFAULT 0,
        kit_commission DECIMAL(12,2) DEFAULT 0,
        author_earnings DECIMAL(12,2) DEFAULT 0,
        currency VARCHAR(3) DEFAULT 'USD',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plugin_id) REFERENCES plugins(id),
        FOREIGN KEY (author_id) REFERENCES authors(id),
        INDEX idx_author_id (author_id),
        INDEX idx_plugin_id (plugin_id)
      )
    `,
  },

  {
    id: "018-create-payment-transactions",
    name: "Create payment transactions table",
    version: "2.0.0",
    sql: `
      CREATE TABLE IF NOT EXISTS payment_transactions (
        id VARCHAR(255) PRIMARY KEY,
        author_id VARCHAR(255) NOT NULL,
        stripe_transfer_id VARCHAR(255),
        amount DECIMAL(12,2) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        attempted_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES authors(id),
        INDEX idx_author_id (author_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      )
    `,
  },

  {
    id: "019-create-grant-applications",
    name: "Create grant applications table",
    version: "2.0.0",
    sql: `
      CREATE TABLE IF NOT EXISTS grant_applications (
        id VARCHAR(255) PRIMARY KEY,
        author_id VARCHAR(255) NOT NULL,
        plugin_id VARCHAR(255) NOT NULL,
        amount_requested DECIMAL(12,2) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        use_case TEXT NOT NULL,
        approved_by VARCHAR(255),
        approval_date TIMESTAMP,
        paid_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES authors(id),
        FOREIGN KEY (plugin_id) REFERENCES plugins(id),
        INDEX idx_author_id (author_id),
        INDEX idx_plugin_id (plugin_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      )
    `,
  },

  // ─── Phase 8: Featured Plugins & Curation ────────────────────────────────
  {
    id: "020-extend-plugins-featured",
    name: "Extend plugins table with featured rotation metadata",
    version: "2.1.0",
    sql: `
      ALTER TABLE plugins ADD COLUMN IF NOT EXISTS
        featured_at TIMESTAMP,
        featured_until TIMESTAMP,
        featured_rotation_slot INTEGER,
        featured_selection_reason VARCHAR(50);

      CREATE TABLE IF NOT EXISTS featured_plugins (
        id VARCHAR(255) PRIMARY KEY,
        plugin_id VARCHAR(255) NOT NULL UNIQUE,
        selected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        slot INTEGER NOT NULL,
        selection_reason VARCHAR(50) NOT NULL,
        selected_by VARCHAR(255),
        views INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        conversions INTEGER DEFAULT 0,
        performance_score DECIMAL(5,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plugin_id) REFERENCES plugins(id),
        INDEX idx_slot (slot),
        INDEX idx_expires_at (expires_at),
        INDEX idx_selection_reason (selection_reason)
      )
    `,
  },

  // ─── Phase 9: Partner Integration ──────────────────────────────────────────
  {
    id: "021-extend-partners",
    name: "Extend authors table with partner fields",
    version: "2.2.0",
    sql: `
      ALTER TABLE authors ADD COLUMN IF NOT EXISTS
        partner_tier VARCHAR(50),
        partner_agreement_signed_at TIMESTAMP,
        partner_agreement_version VARCHAR(20),
        partner_organization_type VARCHAR(50),
        partner_api_key VARCHAR(255) UNIQUE,
        partner_webhook_url VARCHAR(255),
        partner_rate_limit INTEGER DEFAULT 1000;

      CREATE TABLE IF NOT EXISTS partner_api_keys (
        id VARCHAR(255) PRIMARY KEY,
        author_id VARCHAR(255) NOT NULL UNIQUE,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        secret_key TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rotated_at TIMESTAMP,
        last_used_at TIMESTAMP,
        INDEX idx_api_key (api_key),
        INDEX idx_author_id (author_id),
        FOREIGN KEY (author_id) REFERENCES authors(id)
      );

      CREATE TABLE IF NOT EXISTS co_developed_plugins (
        id VARCHAR(255) PRIMARY KEY,
        plugin_id VARCHAR(255) NOT NULL UNIQUE,
        partner_author_id VARCHAR(255) NOT NULL,
        primary_author_id VARCHAR(255) NOT NULL,
        revenue_split VARCHAR(50) NOT NULL,
        approval_status VARCHAR(50) DEFAULT 'pending',
        approved_by VARCHAR(255),
        approval_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_partner_id (partner_author_id),
        INDEX idx_primary_id (primary_author_id),
        INDEX idx_status (approval_status),
        FOREIGN KEY (plugin_id) REFERENCES plugins(id),
        FOREIGN KEY (partner_author_id) REFERENCES authors(id),
        FOREIGN KEY (primary_author_id) REFERENCES authors(id)
      );

      CREATE TABLE IF NOT EXISTS partnership_agreements (
        id VARCHAR(255) PRIMARY KEY,
        author_id VARCHAR(255) NOT NULL,
        tier VARCHAR(50) NOT NULL,
        agreement_text TEXT,
        version VARCHAR(20),
        signed_at TIMESTAMP,
        signed_by VARCHAR(255),
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_author_id (author_id),
        INDEX idx_tier (tier),
        FOREIGN KEY (author_id) REFERENCES authors(id)
      )
    `,
  },
];

/**
 * Get migration by ID.
 */
export function getMigrationById(id: string): Migration | undefined {
  return MIGRATIONS.find((m) => m.id === id);
}

/**
 * Get all migrations after a specific version.
 */
export function getMigrationsAfter(version: string): Migration[] {
  return MIGRATIONS.filter((m) => m.version > version);
}

/**
 * Get total migration count.
 */
export function getMigrationCount(): number {
  return MIGRATIONS.length;
}

/**
 * Generate migration summary.
 */
export function getMigrationSummary(): {
  total: number;
  byVersion: Record<string, number>;
} {
  const byVersion: Record<string, number> = {};

  for (const migration of MIGRATIONS) {
    byVersion[migration.version] = (byVersion[migration.version] || 0) + 1;
  }

  return {
    total: MIGRATIONS.length,
    byVersion,
  };
}

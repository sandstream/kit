/**
 * kit Payout Service
 *
 * Handles author payouts, revenue tracking, grant applications,
 * and Stripe Connect integration for marketplace monetization.
 */

import { IdGenerators } from "./id-generator.js";

/**
 * Author payout account info
 */
export interface PayoutAccount {
  id: string;
  authorId: string;
  stripeAccountId?: string;
  status: "pending" | "connected" | "disconnected" | "suspended";
  kycStatus: "pending" | "verified" | "rejected";
  taxId?: string; // encrypted
  bankAccountId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Plugin revenue tracking
 */
export interface PluginRevenue {
  id: string;
  pluginId: string;
  authorId: string;
  grossRevenue: number; // cents
  kitCommission: number; // 20%
  authorEarnings: number; // 80%
  currency: string; // "USD"
  updatedAt: string;
}

/**
 * Payment transaction (monthly payout)
 */
export interface PaymentTransaction {
  id: string;
  authorId: string;
  stripeTransferId?: string;
  amount: number; // cents
  status: "pending" | "processing" | "completed" | "failed";
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  attemptedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Grant application
 */
export interface GrantApplication {
  id: string;
  authorId: string;
  pluginId: string;
  amountRequested: number; // cents
  status: "pending" | "approved" | "rejected" | "paid";
  useCase: string;
  approvedBy?: string; // admin user ID
  approvalDate?: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Payout service for managing author earnings and payments
 */
export class PayoutService {
  private db: any; // Database connection

  constructor(db?: any) {
    this.db = db;
  }

  /**
   * Record a plugin download and update revenue
   */
  async recordPluginDownload(
    pluginId: string,
    downloadRate: number = 10, // $0.10 cents default
  ): Promise<PluginRevenue> {
    const revenue = await this.db.query(
      `SELECT * FROM plugin_revenue WHERE plugin_id = $1`,
      [pluginId],
    );

    const existing = revenue.rows[0];
    const newGross = (existing?.gross_revenue || 0) + downloadRate;
    const commission = Math.round(newGross * 0.2); // 20% to kit
    const earnings = Math.round(newGross * 0.8); // 80% to author

    const result = await this.db.query(
      `
      INSERT INTO plugin_revenue (id, plugin_id, author_id, gross_revenue, kit_commission, author_earnings, updated_at)
      SELECT $1, $2, author, $3, $4, $5, now()
      FROM plugins WHERE id = $2
      ON CONFLICT (plugin_id) DO UPDATE SET
        gross_revenue = gross_revenue + $3,
        kit_commission = EXCLUDED.gross_revenue * 0.2,
        author_earnings = EXCLUDED.gross_revenue * 0.8,
        updated_at = now()
      RETURNING *
      `,
      [IdGenerators.payout(), pluginId, downloadRate, commission, earnings],
    );

    return this.mapRevenue(result.rows[0]);
  }

  /**
   * Calculate monthly earnings for author
   */
  async calculateMonthlyEarnings(
    authorId: string,
    year: number,
    month: number,
  ): Promise<number> {
    const result = await this.db.query(
      `
      SELECT COALESCE(SUM(author_earnings), 0) as total
      FROM plugin_revenue
      WHERE author_id = $1
        AND EXTRACT(YEAR FROM updated_at) = $2
        AND EXTRACT(MONTH FROM updated_at) = $3
      `,
      [authorId, year, month],
    );

    return result.rows[0]?.total || 0;
  }

  /**
   * Create monthly payout transaction
   */
  async createPayoutTransaction(
    authorId: string,
    amount: number,
    periodStart: string,
    periodEnd: string,
  ): Promise<PaymentTransaction> {
    const id = IdGenerators.payout();
    const result = await this.db.query(
      `
      INSERT INTO payment_transactions
      (id, author_id, amount, status, period_start, period_end, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now(), now())
      RETURNING *
      `,
      [id, authorId, amount, "pending", periodStart, periodEnd],
    );

    return this.mapTransaction(result.rows[0]);
  }

  /**
   * Trigger monthly payouts (cron job, runs 1st of month)
   */
  async triggerMonthlyPayouts(): Promise<PaymentTransaction[]> {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const year = lastMonth.getFullYear();
    const month = lastMonth.getMonth() + 1;

    const authors = await this.db.query(
      `
      SELECT DISTINCT author_id FROM plugin_revenue
      WHERE author_earnings > 0
      `,
    );

    const payouts: PaymentTransaction[] = [];

    for (const { author_id } of authors.rows) {
      const earnings = await this.calculateMonthlyEarnings(author_id, year, month);

      if (earnings > 100) { // Minimum $1.00 payout threshold
        const periodStart = `${year}-${String(month).padStart(2, "0")}-01`;
        const periodEnd = new Date(year, month, 0)
          .toISOString()
          .split("T")[0];

        const tx = await this.createPayoutTransaction(
          author_id,
          earnings,
          periodStart,
          periodEnd,
        );
        payouts.push(tx);
      }
    }

    return payouts;
  }

  /**
   * Process pending payouts (transfers to author Stripe accounts)
   */
  async processPayouts(batchSize: number = 10): Promise<PaymentTransaction[]> {
    const pending = await this.db.query(
      `
      SELECT pt.* FROM payment_transactions pt
      WHERE pt.status = 'pending'
      AND pt.created_at < now() - interval '2 days'
      LIMIT $1
      `,
      [batchSize],
    );

    const processed: PaymentTransaction[] = [];

    for (const tx of pending.rows) {
      // Get author's Stripe account
      const account = await this.db.query(
        `SELECT stripe_account_id FROM author_payout_accounts WHERE author_id = $1`,
        [tx.author_id],
      );

      if (!account.rows[0]?.stripe_account_id) {
        // Skip if no Stripe account connected
        continue;
      }

      try {
        // In real implementation, call Stripe API here
        // const transfer = await stripe.transfers.create({
        //   destination: account.rows[0].stripe_account_id,
        //   amount: tx.amount,
        //   currency: 'usd',
        // });

        // For now, simulate successful transfer
        const result = await this.db.query(
          `
          UPDATE payment_transactions
          SET status = $1, attempted_at = now(), updated_at = now()
          WHERE id = $2
          RETURNING *
          `,
          ["processing", tx.id],
        );

        processed.push(this.mapTransaction(result.rows[0]));
      } catch (error) {
        // Log error and mark as failed
        console.error(`Failed to process payout ${tx.id}:`, error);
        await this.db.query(
          `
          UPDATE payment_transactions
          SET status = $1, updated_at = now()
          WHERE id = $2
          `,
          ["failed", tx.id],
        );
      }
    }

    return processed;
  }

  /**
   * Submit grant application
   */
  async submitGrant(
    authorId: string,
    pluginId: string,
    amountRequested: number,
    useCase: string,
  ): Promise<GrantApplication> {
    const id = IdGenerators.grant();
    const result = await this.db.query(
      `
      INSERT INTO grant_applications
      (id, author_id, plugin_id, amount_requested, status, use_case, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now(), now())
      RETURNING *
      `,
      [id, authorId, pluginId, amountRequested, "pending", useCase],
    );

    return this.mapGrant(result.rows[0]);
  }

  /**
   * Approve grant (admin only)
   */
  async approveGrant(
    grantId: string,
    approvedBy: string,
  ): Promise<GrantApplication> {
    const result = await this.db.query(
      `
      UPDATE grant_applications
      SET status = $1, approved_by = $2, approval_date = now(), updated_at = now()
      WHERE id = $3
      RETURNING *
      `,
      ["approved", approvedBy, grantId],
    );

    const grant = this.mapGrant(result.rows[0]);

    // Immediately create payout transaction for grant amount
    await this.createPayoutTransaction(
      grant.authorId,
      grant.amountRequested,
      new Date().toISOString().split("T")[0],
      new Date().toISOString().split("T")[0],
    );

    return grant;
  }

  /**
   * Reject grant (admin only)
   */
  async rejectGrant(grantId: string): Promise<GrantApplication> {
    const result = await this.db.query(
      `
      UPDATE grant_applications
      SET status = $1, updated_at = now()
      WHERE id = $2
      RETURNING *
      `,
      ["rejected", grantId],
    );

    return this.mapGrant(result.rows[0]);
  }

  /**
   * Get pending grants (admin dashboard)
   */
  async getPendingGrants(limit: number = 20): Promise<GrantApplication[]> {
    const result = await this.db.query(
      `
      SELECT * FROM grant_applications
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit],
    );

    return result.rows.map((row: any) => this.mapGrant(row));
  }

  /**
   * Get author payout status
   */
  async getPayoutStatus(authorId: string): Promise<PayoutAccount | null> {
    const result = await this.db.query(
      `SELECT * FROM author_payout_accounts WHERE author_id = $1`,
      [authorId],
    );

    return result.rows[0] ? this.mapPayoutAccount(result.rows[0]) : null;
  }

  /**
   * Setup payout account (initiate Stripe Connect)
   */
  async setupPayoutAccount(
    authorId: string,
    email: string,
  ): Promise<PayoutAccount> {
    // Check if account exists
    const existing = await this.getPayoutStatus(authorId);
    if (existing) {
      return existing;
    }

    const id = IdGenerators.payout();
    const result = await this.db.query(
      `
      INSERT INTO author_payout_accounts
      (id, author_id, status, kyc_status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, now(), now())
      RETURNING *
      `,
      [id, authorId, "pending", "pending"],
    );

    return this.mapPayoutAccount(result.rows[0]);
  }

  /**
   * Mark payout transaction as completed (webhook handler)
   */
  async completePayoutTransaction(
    stripeTransferId: string,
  ): Promise<PaymentTransaction> {
    const result = await this.db.query(
      `
      UPDATE payment_transactions
      SET status = $1, completed_at = now(), updated_at = now()
      WHERE stripe_transfer_id = $2
      RETURNING *
      `,
      ["completed", stripeTransferId],
    );

    return this.mapTransaction(result.rows[0]);
  }

  /**
   * Map database row to PayoutAccount
   */
  private mapPayoutAccount(row: any): PayoutAccount {
    return {
      id: row.id,
      authorId: row.author_id,
      stripeAccountId: row.stripe_account_id,
      status: row.status,
      kycStatus: row.kyc_status,
      taxId: row.tax_id,
      bankAccountId: row.bank_account_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Map database row to PluginRevenue
   */
  private mapRevenue(row: any): PluginRevenue {
    return {
      id: row.id,
      pluginId: row.plugin_id,
      authorId: row.author_id,
      grossRevenue: row.gross_revenue,
      kitCommission: row.kit_commission,
      authorEarnings: row.author_earnings,
      currency: row.currency || "USD",
      updatedAt: row.updated_at,
    };
  }

  /**
   * Map database row to PaymentTransaction
   */
  private mapTransaction(row: any): PaymentTransaction {
    return {
      id: row.id,
      authorId: row.author_id,
      stripeTransferId: row.stripe_transfer_id,
      amount: row.amount,
      status: row.status,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      attemptedAt: row.attempted_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Map database row to GrantApplication
   */
  private mapGrant(row: any): GrantApplication {
    return {
      id: row.id,
      authorId: row.author_id,
      pluginId: row.plugin_id,
      amountRequested: row.amount_requested,
      status: row.status,
      useCase: row.use_case,
      approvedBy: row.approved_by,
      approvalDate: row.approval_date,
      paidAt: row.paid_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

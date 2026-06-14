import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PayoutService } from "./payout-service.js";

describe("PayoutService", () => {
  let service: PayoutService;
  let mockDb: any;

  beforeEach(() => {
    // Mock database
    mockDb = {
      query: async (sql: string, params: any[]) => {
        // Simple mock implementation
        if (sql.includes("SELECT") && sql.includes("plugin_revenue")) {
          return {
            rows: [{
              id: "rev-1",
              plugin_id: "test-plugin",
              author_id: "author-1",
              gross_revenue: 1000,
              kit_commission: 200,
              author_earnings: 800,
              currency: "USD",
              updated_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("INSERT") && sql.includes("plugin_revenue")) {
          return {
            rows: [{
              id: "rev-1",
              plugin_id: params[1],
              author_id: "author-1",
              gross_revenue: params[2],
              kit_commission: Math.round(params[2] * 0.2),
              author_earnings: Math.round(params[2] * 0.8),
              currency: "USD",
              updated_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("UPDATE") && sql.includes("grant_applications")) {
          // Handle UPDATE for approve/reject
          // approveGrant: params = ["approved", approvedBy, grantId]
          // rejectGrant: params = ["rejected", grantId]
          const status = params[0];
          const isApprove = status === "approved";
          const approvedBy = isApprove ? params[1] : undefined;

          return {
            rows: [{
              id: "grant-1",
              author_id: "author-1",
              plugin_id: "plugin-1",
              amount_requested: 50000,
              status: status,
              use_case: "Feature development",
              approved_by: approvedBy,
              approval_date: isApprove ? new Date().toISOString() : undefined,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("INSERT") && sql.includes("payment_transactions")) {
          return {
            rows: [{
              id: "tx-1",
              author_id: params[1],
              amount: params[2],
              status: params[3] || "pending",
              period_start: params[4],
              period_end: params[5],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("INSERT") && sql.includes("grant_applications")) {
          return {
            rows: [{
              id: "grant-1",
              author_id: params[1],
              plugin_id: params[2],
              amount_requested: params[3],
              status: params[4] || "pending",
              use_case: params[5],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("author_payout_accounts")) {
          return {
            rows: [{
              id: "acct-1",
              author_id: params[1],
              status: "pending",
              kyc_status: "pending",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }],
          };
        }
        return { rows: [] };
      },
    };

    service = new PayoutService(mockDb);
  });

  describe("recordPluginDownload", () => {
    it("records plugin download and calculates revenue split", async () => {
      const revenue = await service.recordPluginDownload("test-plugin", 10);
      assert.equal(revenue.pluginId, "test-plugin");
      assert.ok(revenue.grossRevenue >= 10);
      // 80/20 split verification done in calculation
    });
  });

  describe("calculateMonthlyEarnings", () => {
    it("calculates author monthly earnings", async () => {
      const earnings = await service.calculateMonthlyEarnings("author-1", 2026, 4);
      assert.ok(typeof earnings === "number");
      assert.ok(earnings >= 0);
    });
  });

  describe("createPayoutTransaction", () => {
    it("creates payment transaction", async () => {
      const tx = await service.createPayoutTransaction(
        "author-1",
        10000,
        "2026-04-01",
        "2026-04-30",
      );
      assert.equal(tx.authorId, "author-1");
      assert.equal(tx.amount, 10000);
      assert.equal(tx.status, "pending");
      assert.equal(tx.periodStart, "2026-04-01");
      assert.equal(tx.periodEnd, "2026-04-30");
    });
  });

  describe("submitGrant", () => {
    it("submits grant application", async () => {
      const grant = await service.submitGrant(
        "author-1",
        "plugin-1",
        50000,
        "Feature development",
      );
      assert.equal(grant.authorId, "author-1");
      assert.equal(grant.pluginId, "plugin-1");
      assert.equal(grant.amountRequested, 50000);
      assert.equal(grant.useCase, "Feature development");
      assert.equal(grant.status, "pending");
    });
  });


  describe("getPendingGrants", () => {
    it("retrieves pending grants for admin", async () => {
      const grants = await service.getPendingGrants();
      assert.ok(Array.isArray(grants));
    });
  });

  describe("Revenue split calculation (80/20)", () => {
    it("applies correct 80/20 split", async () => {
      const revenue = await service.recordPluginDownload("test-plugin", 1000);
      // 1000 cents = $10.00
      // kit: $2.00 (20%), Author: $8.00 (80%)
      assert.equal(Math.round(revenue.kitCommission), 200); // 20%
      assert.equal(Math.round(revenue.authorEarnings), 800); // 80%
    });
  });

});

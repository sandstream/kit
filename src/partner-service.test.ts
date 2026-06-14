import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PartnerService } from "./partner-service.js";

describe("PartnerService", () => {
  let service: PartnerService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      query: async (sql: string, params: any[]) => {
        if (sql.includes("UPDATE authors") && sql.includes("partner_tier")) {
          // enrollAsPartner
          return {
            rows: [{
              id: params[3],
              partner_tier: params[0],
              partner_organization_type: params[1],
              partner_rate_limit: params[2],
              partner_agreement_signed_at: null,
              partner_agreement_version: null,
              partner_webhook_url: null,
            }],
          };
        }
        if (sql.includes("INSERT INTO partnership_agreements")) {
          return { rows: [{ id: params[0] }] };
        }
        if (sql.includes("UPDATE authors") && sql.includes("partner_agreement")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO partner_api_keys")) {
          // generateApiKey
          return {
            rows: [{
              id: params[0],
              author_id: params[1],
              api_key: params[2],
              created_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("SELECT a.* FROM authors a") && sql.includes("partner_api_keys")) {
          // validateApiKey
          return {
            rows: [{
              id: params[0] || "author-1",
              partner_tier: "gold",
              partner_organization_type: "enterprise",
              partner_rate_limit: 1000,
              partner_agreement_signed_at: new Date().toISOString(),
              partner_agreement_version: "1.0",
              partner_webhook_url: "https://example.com/webhook",
            }],
          };
        }
        if (sql.includes("UPDATE partner_api_keys") && sql.includes("last_used_at")) {
          return { rows: [] };
        }
        if (sql.includes("SELECT * FROM partner_api_keys WHERE author_id")) {
          // rotateApiKey - get old key
          return {
            rows: [{
              id: "key-old",
              author_id: params[0],
              api_key: "pk_oldkey",
            }],
          };
        }
        if (sql.includes("DELETE FROM partner_api_keys")) {
          return { rows: [] };
        }
        if (sql.includes("SELECT * FROM authors WHERE id")) {
          // getPartnerProfile
          return {
            rows: [{
              id: params[0],
              partner_tier: "silver",
              partner_organization_type: "startup",
              partner_rate_limit: 500,
              partner_agreement_signed_at: new Date().toISOString(),
              partner_agreement_version: "1.0",
              partner_webhook_url: null,
            }],
          };
        }
        if (sql.includes("INSERT INTO co_developed_plugins")) {
          // createCoDevelopedPlugin
          return {
            rows: [{
              id: params[0],
              plugin_id: params[1],
              partner_author_id: params[2],
              primary_author_id: params[3],
              revenue_split: params[4],
              approval_status: params[5],
              approved_by: null,
              approval_date: null,
              created_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("UPDATE co_developed_plugins") && sql.includes("approval_status")) {
          // approveCoDevelopedPlugin
          return {
            rows: [{
              id: params[2],
              plugin_id: "plugin-1",
              partner_author_id: "author-2",
              primary_author_id: "author-1",
              revenue_split: "50-50",
              approval_status: params[0],
              approved_by: params[1],
              approval_date: new Date().toISOString(),
              created_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("SELECT * FROM co_developed_plugins")) {
          // getPartnerCoDevelopedPlugins
          return {
            rows: [{
              id: "coplugin-1",
              plugin_id: "plugin-1",
              partner_author_id: "author-2",
              primary_author_id: "author-1",
              revenue_split: "50-50",
              approval_status: "approved",
              approved_by: "admin-1",
              approval_date: new Date().toISOString(),
              created_at: new Date().toISOString(),
            }],
          };
        }
        return { rows: [] };
      },
    };

    service = new PartnerService(mockDb);
  });

  describe("enrollAsPartner", () => {
    it("enrolls author as partner with tier and org type", async () => {
      const profile = await service.enrollAsPartner(
        "author-1",
        "gold",
        "enterprise"
      );
      assert.equal(profile.authorId, "author-1");
      assert.equal(profile.partnerTier, "gold");
      assert.equal(profile.organizationType, "enterprise");
      assert.equal(profile.rateLimit, 1000);
    });

    it("supports all partner tiers", async () => {
      for (const tier of ["bronze", "silver", "gold", "platinum"] as const) {
        const profile = await service.enrollAsPartner("author-1", tier, "startup");
        assert.equal(profile.partnerTier, tier);
      }
    });
  });

  describe("signPartnerAgreement", () => {
    it("signs partnership agreement and updates author", async () => {
      await service.signPartnerAgreement("author-1", "gold", "1.0");
      // No assertion needed - method returns void, just verify no error
      assert.ok(true);
    });
  });

  describe("generateApiKey", () => {
    it("generates new API key for partner", async () => {
      const key = await service.generateApiKey("author-1");
      assert.ok(key.id.startsWith("key-"));
      assert.equal(key.authorId, "author-1");
      assert.ok(key.apiKey.startsWith("pk_"));
      assert.ok(key.createdAt);
    });

    it("creates unique API keys", async () => {
      const key1 = await service.generateApiKey("author-1");
      const key2 = await service.generateApiKey("author-2");
      assert.notEqual(key1.apiKey, key2.apiKey);
    });
  });

  describe("validateApiKey", () => {
    it("validates API key and returns partner profile", async () => {
      const profile = await service.validateApiKey("pk_test123");
      assert.ok(profile);
      assert.equal(profile.partnerTier, "gold");
      assert.equal(profile.organizationType, "enterprise");
    });

    it("returns null for invalid API key", async () => {
      mockDb.query = async (sql: string) => {
        if (sql.includes("SELECT a.* FROM authors")) {
          return { rows: [] };
        }
        return { rows: [] };
      };
      service = new PartnerService(mockDb);
      const profile = await service.validateApiKey("pk_invalid");
      assert.equal(profile, null);
    });

    it("updates last_used_at on validation", async () => {
      let updateCalled = false;
      mockDb.query = async (sql: string, params: any[]) => {
        if (sql.includes("SELECT a.* FROM authors")) {
          return {
            rows: [{
              id: "author-1",
              partner_tier: "gold",
              partner_organization_type: "enterprise",
              partner_rate_limit: 1000,
            }],
          };
        }
        if (sql.includes("UPDATE partner_api_keys")) {
          updateCalled = true;
        }
        return { rows: [] };
      };
      service = new PartnerService(mockDb);
      await service.validateApiKey("pk_test");
      assert.ok(updateCalled);
    });
  });

  describe("rotateApiKey", () => {
    it("rotates API key for partner", async () => {
      const newKey = await service.rotateApiKey("author-1");
      assert.ok(newKey.id.startsWith("key-"));
      assert.equal(newKey.authorId, "author-1");
      assert.ok(newKey.apiKey.startsWith("pk_"));
    });

    it("throws error if no API key found", async () => {
      mockDb.query = async (sql: string) => {
        if (sql.includes("SELECT * FROM partner_api_keys WHERE author_id")) {
          return { rows: [] };
        }
        return { rows: [] };
      };
      service = new PartnerService(mockDb);
      await assert.rejects(
        () => service.rotateApiKey("author-1"),
        /No API key found/
      );
    });
  });

  describe("getPartnerProfile", () => {
    it("retrieves partner profile by author ID", async () => {
      const profile = await service.getPartnerProfile("author-1");
      assert.ok(profile);
      assert.equal(profile.authorId, "author-1");
      assert.equal(profile.partnerTier, "silver");
      assert.equal(profile.organizationType, "startup");
    });

    it("returns null if author not found", async () => {
      mockDb.query = async (sql: string) => {
        if (sql.includes("SELECT * FROM authors WHERE id")) {
          return { rows: [] };
        }
        return { rows: [] };
      };
      service = new PartnerService(mockDb);
      const profile = await service.getPartnerProfile("author-1");
      assert.equal(profile, null);
    });
  });

  describe("createCoDevelopedPlugin", () => {
    it("creates co-developed plugin partnership", async () => {
      const coPlugin = await service.createCoDevelopedPlugin(
        "plugin-1",
        "author-2",
        "author-1",
        "50-50"
      );
      assert.ok(coPlugin.id.startsWith("coplugin-"));
      assert.equal(coPlugin.pluginId, "plugin-1");
      assert.equal(coPlugin.partnerAuthorId, "author-2");
      assert.equal(coPlugin.primaryAuthorId, "author-1");
      assert.equal(coPlugin.revenueSplit, "50-50");
      assert.equal(coPlugin.approvalStatus, "pending");
    });

    it("supports custom revenue splits", async () => {
      const splits = ["60-40", "70-30", "80-20"];
      for (const split of splits) {
        const coPlugin = await service.createCoDevelopedPlugin(
          "plugin-1",
          "author-2",
          "author-1",
          split
        );
        assert.equal(coPlugin.revenueSplit, split);
      }
    });
  });

  describe("approveCoDevelopedPlugin", () => {
    it("approves co-developed plugin partnership", async () => {
      const approved = await service.approveCoDevelopedPlugin(
        "coplugin-1",
        "admin-1"
      );
      assert.equal(approved.approvalStatus, "approved");
      assert.equal(approved.approvedBy, "admin-1");
      assert.ok(approved.approvalDate);
    });
  });

  describe("getPartnerCoDevelopedPlugins", () => {
    it("retrieves co-developed plugins for partner", async () => {
      const plugins = await service.getPartnerCoDevelopedPlugins("author-1");
      assert.ok(Array.isArray(plugins));
      if (plugins.length > 0) {
        assert.ok(plugins[0].id);
        assert.ok(plugins[0].pluginId);
      }
    });
  });

  describe("calculatePartnerShare", () => {
    it("calculates partner share from revenue split", () => {
      const result = service.calculatePartnerShare(1000, "50-50");
      assert.equal(result.partnerShare, 500);
      assert.equal(result.primaryShare, 500);
    });

    it("handles 60-40 split", () => {
      const result = service.calculatePartnerShare(1000, "60-40");
      assert.equal(result.partnerShare, 600);
      assert.equal(result.primaryShare, 400);
    });

    it("handles 70-30 split", () => {
      const result = service.calculatePartnerShare(1000, "70-30");
      assert.equal(result.partnerShare, 700);
      assert.equal(result.primaryShare, 300);
    });

    it("handles custom splits", () => {
      const result = service.calculatePartnerShare(1000, "80-20");
      assert.equal(result.partnerShare, 800);
      assert.equal(result.primaryShare, 200);
    });
  });
});

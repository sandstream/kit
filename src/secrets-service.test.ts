import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initializeVault,
  storeSecret,
  retrieveSecret,
  rotateSecret,
  shareSecret,
  revokeSecret,
  getSecretMetadata,
  listSecrets,
  rotateEncryptionKey,
  getVaultMetrics,
  getAccessLogs,
} from "./secrets-service.js";

describe("secrets-service", () => {
  const teamId = "team-vault-123";
  const userId = "user-456";
  const adminId = "admin-789";

  describe("initializeVault", () => {
    it("creates encryption key for team", () => {
      const { key, error } = initializeVault(teamId);

      assert.ok(!error);
      assert.ok(key.id);
      assert.equal(key.team_id, teamId);
      assert.equal(key.status, "active");
      assert.equal(key.key_version, 1);
    });

    it("returns existing key if vault already initialized", () => {
      const team2 = "team-vault-existing";
      const { key: key1 } = initializeVault(team2);
      const { key: key2 } = initializeVault(team2);

      assert.equal(key1.id, key2.id);
    });
  });

  describe("storeSecret", () => {
    it("stores encrypted secret", () => {
      initializeVault(teamId);

      const { secret, error } = storeSecret(
        teamId,
        "prod_api_key",
        "sk-1234567890abcdef",
        "api_key",
        userId,
        "team",
        "never",
        "Production API key",
      );

      assert.ok(!error);
      assert.ok(secret.id);
      assert.equal(secret.name, "prod_api_key");
      assert.equal(secret.type, "api_key");
      assert.equal(secret.created_by, userId);
    });

    it("rejects missing name or value", () => {
      initializeVault(teamId);

      const { error } = storeSecret(teamId, "", "value", "api_key", userId);

      assert.ok(error);
      assert.ok(error?.includes("required"));
    });

    it("fails if vault not initialized", () => {
      const { error } = storeSecret("team-noinit", "key", "value", "api_key", userId);

      assert.ok(error);
      assert.equal(error, "Vault not initialized");
    });

    it("stores secret with rotation policy", () => {
      initializeVault(teamId);

      const { secret, error } = storeSecret(
        teamId,
        "rotated_key",
        "secret",
        "password",
        userId,
        "team",
        "30d",
      );

      assert.ok(!error);
      assert.equal(secret.rotation_policy, "30d");
      assert.ok(secret.next_rotation_at);
    });

    it("stores secret with expiry", () => {
      initializeVault(teamId);
      const expireDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const { secret, error } = storeSecret(
        teamId,
        "temp_token",
        "token123",
        "oauth_token",
        userId,
        "shared",
        "never",
        undefined,
        expireDate,
      );

      assert.ok(!error);
      assert.equal(secret.expires_at, expireDate);
    });
  });

  describe("retrieveSecret", () => {
    const retrieveTeamId = "team-retrieve-123";

    it("retrieves and decrypts secret", () => {
      initializeVault(retrieveTeamId);

      const secretValue = "sk-prod-1234567890";
      const { secret } = storeSecret(
        retrieveTeamId,
        "api_key_prod",
        secretValue,
        "api_key",
        userId,
      );

      const { value, error } = retrieveSecret(retrieveTeamId, secret.id, userId);

      assert.ok(!error);
      assert.equal(value, secretValue);
    });

    it("denies access to expired secret", () => {
      initializeVault(retrieveTeamId);
      const expireDate = new Date(Date.now() - 1000).toISOString(); // Already expired

      const { secret } = storeSecret(
        retrieveTeamId,
        "expired_token",
        "token123",
        "oauth_token",
        userId,
        "team",
        "never",
        undefined,
        expireDate,
      );

      const { value, error } = retrieveSecret(retrieveTeamId, secret.id, userId);

      assert.ok(error);
      assert.equal(error, "Secret expired");
      assert.equal(value, "");
    });

    it("returns error for nonexistent secret", () => {
      const { error } = retrieveSecret(retrieveTeamId, "nonexistent-123", userId);

      assert.ok(error);
      assert.equal(error, "Secret not found");
    });

    it("logs access in audit trail", () => {
      initializeVault(retrieveTeamId);

      const { secret, error: storeError } = storeSecret(
        retrieveTeamId,
        "logged_key",
        "value",
        "api_key",
        userId,
      );
      assert.ok(!storeError);

      const { error } = retrieveSecret(retrieveTeamId, secret.id, userId, "192.168.1.1");
      assert.ok(!error);

      const { logs, total } = getAccessLogs(retrieveTeamId);

      assert.ok(total >= 2); // store + retrieve
      // Match this test's own read by secret_id — retrieveTeamId is shared across
      // the block, so an earlier read-success log (no ip) would otherwise be found first.
      const readLog = logs.find(
        (l) => l.action === "read" && l.status === "success" && l.secret_id === secret.id,
      );
      assert.ok(readLog);
      assert.equal(readLog?.ip_address, "192.168.1.1");
    });
  });

  describe("rotateSecret", () => {
    const rotateTeamId = "team-rotate-123";

    it("rotates secret to new encryption key", () => {
      initializeVault(rotateTeamId);

      const { secret: original } = storeSecret(
        rotateTeamId,
        "rotate_me",
        "secret123",
        "api_key",
        userId,
      );
      const originalKeyId = original.encryption_key_id;
      const { secret: rotated, error } = rotateSecret(rotateTeamId, original.id, adminId, "manual");

      assert.ok(!error);
      assert.ok(rotated.last_rotated_at);
      assert.notEqual(originalKeyId, rotated.encryption_key_id);
    });

    it("updates next rotation date", () => {
      initializeVault(rotateTeamId);

      const { secret: original } = storeSecret(
        rotateTeamId,
        "auto_rotate",
        "secret",
        "password",
        userId,
        "team",
        "30d",
      );

      // Add small delay to ensure timestamps differ (otherwise may be same millisecond)
      const { secret: rotated } = rotateSecret(rotateTeamId, original.id, adminId, "scheduled");

      assert.ok(rotated.next_rotation_at);
      assert.ok(rotated.last_rotated_at);
    });

    it("fails for nonexistent secret", () => {
      const { error } = rotateSecret(rotateTeamId, "nonexistent-123", adminId);

      assert.ok(error);
      assert.equal(error, "Secret not found");
    });
  });

  describe("shareSecret", () => {
    it("shares secret with user", () => {
      initializeVault(teamId);

      const { secret } = storeSecret(teamId, "db_creds", "postgres://...", "database_url", userId);
      const { share, error } = shareSecret(teamId, secret.id, userId, "shared-user-123");

      assert.ok(!error);
      assert.ok(share.id);
      assert.equal(share.shared_with_user_id, "shared-user-123");
    });

    it("shares secret with team", () => {
      initializeVault(teamId);

      const { secret } = storeSecret(teamId, "team_secret", "value", "api_key", userId);
      const { share, error } = shareSecret(teamId, secret.id, userId, undefined, "team-devops-123");

      assert.ok(!error);
      assert.equal(share.shared_with_team_id, "team-devops-123");
    });

    it("creates one-time access share", () => {
      initializeVault(teamId);

      const { secret } = storeSecret(teamId, "one_time", "secret", "api_key", userId);
      const { share, error } = shareSecret(
        teamId,
        secret.id,
        userId,
        "recipient-123",
        undefined,
        undefined,
        true,
      );

      assert.ok(!error);
      assert.ok(share.one_time);
    });

    it("rejects share without recipient", () => {
      initializeVault(teamId);

      const { secret } = storeSecret(teamId, "no_recipient", "value", "api_key", userId);
      const { error } = shareSecret(teamId, secret.id, userId);

      assert.ok(error);
      assert.ok(error?.includes("user or team"));
    });
  });

  describe("revokeSecret", () => {
    it("revokes secret and access shares", () => {
      initializeVault(teamId);

      const { secret } = storeSecret(teamId, "revoke_me", "value", "api_key", userId);
      shareSecret(teamId, secret.id, userId, "someone-123");

      const { success } = revokeSecret(teamId, secret.id, adminId);

      assert.ok(success);

      // Verify secret is gone
      const { error } = retrieveSecret(teamId, secret.id, userId);
      assert.ok(error);
    });

    it("fails for nonexistent secret", () => {
      const { success, error } = revokeSecret(teamId, "nonexistent-123", adminId);

      assert.ok(!success);
      assert.equal(error, "Secret not found");
    });
  });

  describe("getSecretMetadata", () => {
    it("returns secret without encrypted value", () => {
      initializeVault(teamId);

      const { secret: stored } = storeSecret(
        teamId,
        "metadata_test",
        "secret_value",
        "api_key",
        userId,
      );
      const { secret } = getSecretMetadata(teamId, stored.id);

      assert.ok(secret);
      assert.equal(secret?.name, "metadata_test");
      assert.equal(secret?.type, "api_key");
      assert.ok(secret?.created_by);
    });
  });

  describe("listSecrets", () => {
    it("lists all team secrets", () => {
      const team3 = "team-list-123";
      initializeVault(team3);

      storeSecret(team3, "api_1", "value", "api_key", userId);
      storeSecret(team3, "pwd_1", "secret", "password", userId);

      const { secrets } = listSecrets(team3);

      assert.equal(secrets.length, 2);
      assert.ok(secrets[0].name);
    });

    it("filters secrets by type", () => {
      const team4 = "team-filter-123";
      initializeVault(team4);

      storeSecret(team4, "api_1", "value", "api_key", userId);
      storeSecret(team4, "pwd_1", "secret", "password", userId);
      storeSecret(team4, "api_2", "value2", "api_key", userId);

      const { secrets } = listSecrets(team4, "api_key");

      assert.equal(secrets.length, 2);
      assert.ok(secrets.every((s) => s.type === "api_key"));
    });
  });

  describe("rotateEncryptionKey", () => {
    it("retires old key and creates new key", () => {
      initializeVault(teamId);

      const { key: oldKey } = initializeVault(teamId);
      const { key: newKey, error } = rotateEncryptionKey(teamId, adminId);

      assert.ok(!error);
      assert.equal(newKey.key_version, oldKey.key_version + 1);
      assert.equal(newKey.status, "active");
    });
  });

  describe("getVaultMetrics", () => {
    it("calculates vault metrics", () => {
      const team5 = "team-metrics-123";
      initializeVault(team5);

      storeSecret(team5, "api_1", "value", "api_key", userId);
      storeSecret(team5, "api_2", "value", "api_key", userId);
      storeSecret(team5, "pwd_1", "secret", "password", userId);
      const { secret } = storeSecret(
        team5,
        "db_1",
        "postgres://",
        "database_url",
        userId,
        "team",
        "90d",
      );

      shareSecret(team5, secret.id, userId, "share-user-123");

      const metrics = getVaultMetrics(team5);

      assert.equal(metrics.total_secrets, 4);
      assert.equal(metrics.secrets_by_type.api_key, 2);
      assert.equal(metrics.secrets_by_type.password, 1);
      assert.equal(metrics.secrets_by_type.database_url, 1);
      assert.equal(metrics.total_shares, 1);
      assert.equal(metrics.active_keys, 1);
    });

    it("counts secrets expiring soon", () => {
      const team6 = "team-expiring-123";
      initializeVault(team6);

      const soonDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days
      storeSecret(
        team6,
        "expiring_token",
        "token",
        "oauth_token",
        userId,
        "team",
        "never",
        undefined,
        soonDate,
      );

      const metrics = getVaultMetrics(team6);

      assert.equal(metrics.expiring_soon, 1);
    });

    it("counts secrets pending rotation", () => {
      const team7 = "team-rotation-123";
      initializeVault(team7);

      // Create a secret with 30d rotation, then artificially age it
      const { secret } = storeSecret(
        team7,
        "old_secret",
        "value",
        "api_key",
        userId,
        "team",
        "30d",
      );

      // Simulate age by setting last_rotated_at far in past
      secret.last_rotated_at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      secret.next_rotation_at = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

      const metrics = getVaultMetrics(team7);

      assert.equal(metrics.pending_rotation, 1);
    });
  });

  describe("getAccessLogs", () => {
    it("returns audit logs of secret access", () => {
      const team8 = "team-audit-123";
      initializeVault(team8);

      const { secret } = storeSecret(team8, "audit_test", "value", "api_key", userId);
      retrieveSecret(team8, secret.id, userId);

      const { logs, total } = getAccessLogs(team8);

      assert.ok(total >= 2);
      assert.ok(logs.some((l) => l.action === "created"));
      assert.ok(logs.some((l) => l.action === "read"));
    });

    it("logs denied access attempts", () => {
      const team9 = "team-denied-123";
      initializeVault(team9);

      retrieveSecret(team9, "nonexistent-123", userId);

      const { logs } = getAccessLogs(team9);

      const deniedLog = logs.find((l) => l.status === "denied");
      assert.ok(deniedLog);
      assert.equal(deniedLog?.reason, "Secret not found");
    });
  });
});

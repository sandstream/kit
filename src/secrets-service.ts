import { randomUUID } from "node:crypto";
import type {
  Secret,
  EncryptionKey,
  SecretShare,
  SecretAccessLog,
  RotationHistory,
  VaultMetrics,
  SecretType,
  RotationPolicy,
  AccessLevel,
} from "./secrets-model.js";

const secrets = new Map<string, Secret>();
const encryptionKeys = new Map<string, EncryptionKey>();
const secretShares = new Map<string, SecretShare>();
const accessLogs: SecretAccessLog[] = [];
const rotationHistory: RotationHistory[] = [];

/**
 * Initialize vault encryption key for team
 */
export function initializeVault(team_id: string): { key: EncryptionKey; error?: string } {
  const existing = Array.from(encryptionKeys.values()).find(
    (k) => k.team_id === team_id && k.status === "active",
  );

  if (existing) {
    return { key: existing };
  }

  const key: EncryptionKey = {
    id: `key_${randomUUID()}`,
    team_id,
    key_version: 1,
    algorithm: "aes-256-gcm",
    created_at: new Date().toISOString(),
    status: "active",
  };

  encryptionKeys.set(key.id, key);
  logAccess(team_id, "system", "created", "success");

  return { key };
}

/**
 * Store encrypted secret
 */
export function storeSecret(
  team_id: string,
  name: string,
  secret_value: string,
  type: SecretType,
  created_by: string,
  access_level: AccessLevel = "team",
  rotation_policy: RotationPolicy = "never",
  description?: string,
  expires_at?: string,
  tags?: string[],
): { secret: Secret; error?: string } {
  if (!name || !secret_value) {
    return { secret: {} as Secret, error: "Name and value required" };
  }

  // Get active encryption key
  const activeKey = Array.from(encryptionKeys.values()).find(
    (k) => k.team_id === team_id && k.status === "active",
  );

  if (!activeKey) {
    return { secret: {} as Secret, error: "Vault not initialized" };
  }

  // Simulate encryption (in production, use real encryption)
  const encrypted_value = Buffer.from(secret_value).toString("base64");

  const secret: Secret = {
    id: `secret_${randomUUID()}`,
    team_id,
    name,
    description,
    type,
    encrypted_value,
    encryption_key_id: activeKey.id,
    access_level,
    created_by,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at,
    rotation_policy,
    tags,
  };

  // Set next rotation date
  if (rotation_policy !== "never") {
    const days = parseInt(rotation_policy);
    secret.next_rotation_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  secrets.set(secret.id, secret);
  logAccess(team_id, created_by, "created", "success", secret.id);

  return { secret };
}

/**
 * Retrieve and decrypt secret (audit logged)
 */
export function retrieveSecret(
  team_id: string,
  secret_id: string,
  user_id: string,
  ip_address?: string,
): { value: string; error?: string } {
  const secret = secrets.get(secret_id);

  if (!secret || secret.team_id !== team_id) {
    logAccess(team_id, user_id, "read", "denied", secret_id, "Secret not found");
    return { value: "", error: "Secret not found" };
  }

  // Check expiry
  if (secret.expires_at && new Date(secret.expires_at) < new Date()) {
    logAccess(team_id, user_id, "read", "denied", secret_id, "Secret expired");
    return { value: "", error: "Secret expired" };
  }

  // Simulate decryption (in production, use real decryption)
  const decrypted = Buffer.from(secret.encrypted_value, "base64").toString("utf-8");

  logAccess(team_id, user_id, "read", "success", secret_id, undefined, ip_address);

  return { value: decrypted };
}

/**
 * Rotate secret (new encryption key, retain value)
 */
export function rotateSecret(
  team_id: string,
  secret_id: string,
  rotated_by: string,
  reason: "scheduled" | "manual" | "compromised" = "manual",
): { secret: Secret; error?: string } {
  const secret = secrets.get(secret_id);

  if (!secret || secret.team_id !== team_id) {
    return { secret: {} as Secret, error: "Secret not found" };
  }

  const oldKeyId = secret.encryption_key_id;

  // Rotate encryption key first (creates new active key)
  const currentActiveKey = Array.from(encryptionKeys.values()).find(
    (k) => k.team_id === team_id && k.status === "active",
  );

  if (!currentActiveKey) {
    return { secret: {} as Secret, error: "Vault not initialized" };
  }

  // Create new key and retire old one
  currentActiveKey.status = "retired";
  currentActiveKey.retired_at = new Date().toISOString();

  const newKey: EncryptionKey = {
    id: `key_${randomUUID()}`,
    team_id,
    key_version: currentActiveKey.key_version + 1,
    algorithm: "aes-256-gcm",
    created_at: new Date().toISOString(),
    status: "active",
  };

  encryptionKeys.set(newKey.id, newKey);

  // Decrypt with old key, re-encrypt with new key (simulated)
  const decrypted = Buffer.from(secret.encrypted_value, "base64").toString("utf-8");
  const newEncrypted = Buffer.from(decrypted).toString("base64");

  secret.encryption_key_id = newKey.id;
  secret.encrypted_value = newEncrypted;
  secret.last_rotated_at = new Date().toISOString();
  secret.updated_at = new Date().toISOString();

  if (secret.rotation_policy !== "never") {
    const days = parseInt(secret.rotation_policy);
    secret.next_rotation_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  // Record rotation history
  const history: RotationHistory = {
    id: `rot_${randomUUID()}`,
    secret_id,
    team_id,
    rotated_by,
    old_key_id: oldKeyId,
    new_key_id: newKey.id,
    rotated_at: secret.last_rotated_at,
    reason,
  };

  rotationHistory.push(history);
  logAccess(team_id, rotated_by, "rotated", "success", secret_id);

  return { secret };
}

/**
 * Share secret with user or team
 */
export function shareSecret(
  team_id: string,
  secret_id: string,
  shared_by: string,
  shared_with_user_id?: string,
  shared_with_team_id?: string,
  access_expires_at?: string,
  one_time: boolean = false,
): { share: SecretShare; error?: string } {
  const secret = secrets.get(secret_id);

  if (!secret || secret.team_id !== team_id) {
    return { share: {} as SecretShare, error: "Secret not found" };
  }

  if (!shared_with_user_id && !shared_with_team_id) {
    return { share: {} as SecretShare, error: "Must specify user or team" };
  }

  const share: SecretShare = {
    id: `share_${randomUUID()}`,
    secret_id,
    team_id,
    shared_by,
    shared_with_user_id,
    shared_with_team_id,
    access_expires_at,
    one_time,
    created_at: new Date().toISOString(),
  };

  secretShares.set(share.id, share);
  logAccess(team_id, shared_by, "shared", "success", secret_id);

  return { share };
}

/**
 * Revoke secret access
 */
export function revokeSecret(
  team_id: string,
  secret_id: string,
  revoked_by: string,
): { success: boolean; error?: string } {
  const secret = secrets.get(secret_id);

  if (!secret || secret.team_id !== team_id) {
    return { success: false, error: "Secret not found" };
  }

  // Revoke all shares
  Array.from(secretShares.values())
    .filter((s) => s.secret_id === secret_id)
    .forEach((s) => secretShares.delete(s.id));

  // Delete secret
  secrets.delete(secret_id);
  logAccess(team_id, revoked_by, "revoked", "success", secret_id);

  return { success: true };
}

/**
 * Get secret metadata (without value)
 */
export function getSecretMetadata(
  team_id: string,
  secret_id: string,
): { secret: Omit<Secret, "encrypted_value"> | null } {
  const secret = secrets.get(secret_id);

  if (!secret || secret.team_id !== team_id) {
    return { secret: null };
  }

  const { encrypted_value, ...metadata } = secret;
  return { secret: metadata };
}

/**
 * List team secrets (metadata only)
 */
export function listSecrets(
  team_id: string,
  type?: SecretType,
): { secrets: Omit<Secret, "encrypted_value">[] } {
  const filtered = Array.from(secrets.values())
    .filter((s) => s.team_id === team_id && (!type || s.type === type))
    .map(({ encrypted_value, ...s }) => s);

  return { secrets: filtered };
}

/**
 * Rotate encryption key (decommission old key)
 */
export function rotateEncryptionKey(
  team_id: string,
  rotated_by: string,
): { key: EncryptionKey; error?: string } {
  const activeKey = Array.from(encryptionKeys.values()).find(
    (k) => k.team_id === team_id && k.status === "active",
  );

  if (!activeKey) {
    return { key: {} as EncryptionKey, error: "No active key found" };
  }

  // Retire old key
  activeKey.status = "retired";
  activeKey.retired_at = new Date().toISOString();

  // Create new key
  const newKey: EncryptionKey = {
    id: `key_${randomUUID()}`,
    team_id,
    key_version: activeKey.key_version + 1,
    algorithm: "aes-256-gcm",
    created_at: new Date().toISOString(),
    status: "active",
  };

  encryptionKeys.set(newKey.id, newKey);
  logAccess(team_id, rotated_by, "rotated", "success");

  return { key: newKey };
}

/**
 * Get vault metrics
 */
export function getVaultMetrics(team_id: string): VaultMetrics {
  const teamSecrets = Array.from(secrets.values()).filter((s) => s.team_id === team_id);

  const expiring = teamSecrets.filter(
    (s) => s.expires_at && new Date(s.expires_at) < new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  );

  const pendingRotation = teamSecrets.filter(
    (s) =>
      s.next_rotation_at &&
      new Date(s.next_rotation_at) < new Date() &&
      s.rotation_policy !== "never",
  );

  const secretsByType: Record<SecretType, number> = {
    api_key: 0,
    password: 0,
    oauth_token: 0,
    database_url: 0,
    ssh_key: 0,
    certificate: 0,
    custom: 0,
  };

  teamSecrets.forEach((s) => {
    secretsByType[s.type]++;
  });

  const activeKeys = Array.from(encryptionKeys.values()).filter(
    (k) => k.team_id === team_id && k.status === "active",
  ).length;

  const teamShares = Array.from(secretShares.values()).filter((s) => s.team_id === team_id);

  return {
    total_secrets: teamSecrets.length,
    secrets_by_type: secretsByType,
    expiring_soon: expiring.length,
    pending_rotation: pendingRotation.length,
    total_shares: teamShares.length,
    active_keys: activeKeys,
  };
}

/**
 * Get access audit logs
 */
export function getAccessLogs(
  team_id: string,
  limit = 100,
): { logs: SecretAccessLog[]; total: number } {
  const filtered = accessLogs
    .filter((log) => log.team_id === team_id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  return { logs: filtered, total: accessLogs.filter((l) => l.team_id === team_id).length };
}

/**
 * Log access event
 */
function logAccess(
  team_id: string,
  user_id: string,
  action: string,
  status: "success" | "denied",
  secret_id?: string,
  reason?: string,
  ip_address?: string,
): void {
  const log: SecretAccessLog = {
    id: `log_${randomUUID()}`,
    secret_id: secret_id || "",
    team_id,
    user_id,
    action: action as any,
    status,
    reason,
    ip_address,
    timestamp: new Date().toISOString(),
  };

  accessLogs.push(log);
}

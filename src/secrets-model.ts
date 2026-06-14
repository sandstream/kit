/**
 * Secrets Management System — data models
 * Encrypted storage, key rotation, secret sharing, audit trails
 */

export type SecretType = "api_key" | "password" | "oauth_token" | "database_url" | "ssh_key" | "certificate" | "custom";
export type RotationPolicy = "never" | "30d" | "60d" | "90d" | "manual";
export type AccessLevel = "owner" | "admin" | "team" | "shared";

export interface Secret {
  id: string;
  team_id: string;
  name: string;
  description?: string;
  type: SecretType;
  encrypted_value: string; // Base64-encoded encrypted value
  encryption_key_id: string; // Reference to encryption key version
  access_level: AccessLevel;
  created_by: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  rotation_policy: RotationPolicy;
  last_rotated_at?: string;
  next_rotation_at?: string;
  tags?: string[];
}

export interface EncryptionKey {
  id: string;
  team_id: string;
  key_version: number; // For key rotation tracking
  algorithm: "aes-256-gcm" | "aes-256-cbc";
  created_at: string;
  rotated_at?: string;
  retired_at?: string; // When key was decommissioned
  status: "active" | "retired";
}

export interface SecretShare {
  id: string;
  secret_id: string;
  team_id: string;
  shared_by: string;
  shared_with_user_id?: string; // User ID if shared with individual
  shared_with_team_id?: string; // Team ID if shared with team
  access_expires_at?: string; // Optional access expiry
  one_time: boolean; // If true, access revoked after first read
  accessed_at?: string;
  created_at: string;
}

export interface SecretAccessLog {
  id: string;
  secret_id: string;
  team_id: string;
  user_id: string;
  action: "read" | "created" | "rotated" | "shared" | "revoked" | "deleted";
  ip_address?: string;
  user_agent?: string;
  status: "success" | "denied";
  reason?: string; // If denied
  timestamp: string;
}

export interface RotationHistory {
  id: string;
  secret_id: string;
  team_id: string;
  rotated_by: string;
  old_key_id: string;
  new_key_id: string;
  rotated_at: string;
  reason: "scheduled" | "manual" | "compromised";
}

export interface VaultMetrics {
  total_secrets: number;
  secrets_by_type: Record<SecretType, number>;
  expiring_soon: number; // Secrets expiring within 7 days
  pending_rotation: number; // Secrets needing rotation
  total_shares: number;
  active_keys: number;
}

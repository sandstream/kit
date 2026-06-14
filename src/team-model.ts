/**
 * Team Management System — data models and types
 * Supports RBAC, member management, invitations, audit logging
 */

export type Role = "owner" | "admin" | "developer" | "guest";

export interface Team {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  email: string;
  role: Role;
  invited_at: string;
  joined_at: string | null;
  status: "pending" | "accepted" | "revoked";
}

export interface TeamInvitation {
  id: string;
  team_id: string;
  email: string;
  role: Role;
  token: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export interface AuditLog {
  id: string;
  team_id: string;
  user_id: string;
  action: AuditAction;
  resource_type: string;
  resource_id: string;
  resource_name: string;
  status: "success" | "failure";
  details: Record<string, unknown>;
  timestamp: string;
}

export type AuditAction =
  | "team_created"
  | "team_updated"
  | "team_deleted"
  | "member_invited"
  | "member_joined"
  | "member_removed"
  | "member_role_changed"
  | "member_revoked"
  | "secret_accessed"
  | "secret_rotated"
  | "config_changed";

/**
 * RBAC Permission Matrix
 * Maps role → actions allowed on resources
 */
export const PERMISSION_MATRIX: Record<Role, Record<string, boolean>> = {
  owner: {
    // Full access
    "team:read": true,
    "team:write": true,
    "team:delete": true,
    "member:read": true,
    "member:invite": true,
    "member:remove": true,
    "member:role_change": true,
    "secret:read": true,
    "secret:write": true,
    "secret:manage": true,
    "audit:read": true,
    "billing:manage": true,
  },
  admin: {
    // Full access except billing
    "team:read": true,
    "team:write": true,
    "team:delete": false,
    "member:read": true,
    "member:invite": true,
    "member:remove": true,
    "member:role_change": true,
    "secret:read": true,
    "secret:write": true,
    "secret:manage": true,
    "audit:read": true,
    "billing:manage": false,
  },
  developer: {
    // Can use team resources
    "team:read": true,
    "team:write": false,
    "team:delete": false,
    "member:read": true,
    "member:invite": false,
    "member:remove": false,
    "member:role_change": false,
    "secret:read": true,
    "secret:write": false,
    "secret:manage": false,
    "audit:read": false,
    "billing:manage": false,
  },
  guest: {
    // Read-only access
    "team:read": true,
    "team:write": false,
    "team:delete": false,
    "member:read": true,
    "member:invite": false,
    "member:remove": false,
    "member:role_change": false,
    "secret:read": false,
    "secret:write": false,
    "secret:manage": false,
    "audit:read": false,
    "billing:manage": false,
  },
};

/**
 * Check if role has permission for action
 */
export function hasPermission(role: Role, action: string): boolean {
  return PERMISSION_MATRIX[role]?.[action] ?? false;
}

/**
 * Validate role
 */
export function isValidRole(role: string): role is Role {
  return ["owner", "admin", "developer", "guest"].includes(role);
}

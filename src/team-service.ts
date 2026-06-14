import { randomUUID } from "node:crypto";
import type {
  Team,
  TeamMember,
  TeamInvitation,
  AuditLog,
  Role,
} from "./team-model.js";
import { hasPermission, isValidRole } from "./team-model.js";

/**
 * In-memory team storage (production would use database)
 */
const teams = new Map<string, Team>();
const members = new Map<string, TeamMember>();
const invitations = new Map<string, TeamInvitation>();
const auditLogs: AuditLog[] = [];

/**
 * Create team
 */
export function createTeam(
  name: string,
  owner_id: string,
): { team: Team; error?: string } {
  if (!name || name.trim().length === 0) {
    return { team: {} as Team, error: "Team name required" };
  }

  const team: Team = {
    id: `team_${randomUUID()}`,
    name: name.trim(),
    owner_id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  teams.set(team.id, team);

  // Add owner as member automatically
  const ownerMember: TeamMember = {
    id: `mem_${randomUUID()}`,
    team_id: team.id,
    user_id: owner_id,
    email: `owner-${owner_id}@kit.local`, // Placeholder
    role: "owner",
    invited_at: team.created_at,
    joined_at: team.created_at,
    status: "accepted",
  };
  members.set(ownerMember.id, ownerMember);

  logAudit(team.id, owner_id, "team_created", "team", team.id, name, {
    owner_id,
  });

  return { team };
}

/**
 * Get team by ID
 */
export function getTeam(team_id: string): Team | null {
  return teams.get(team_id) ?? null;
}

/**
 * Invite user to team
 */
export function inviteToTeam(
  team_id: string,
  email: string,
  role: string,
  inviter_id: string,
): { invitation: TeamInvitation; error?: string } {
  // Validate team exists
  const team = teams.get(team_id);
  if (!team) {
    return { invitation: {} as TeamInvitation, error: "Team not found" };
  }

  // Check inviter has permission
  const inviter = Array.from(members.values()).find(
    (m) => m.team_id === team_id && m.user_id === inviter_id,
  );
  if (!inviter || !hasPermission(inviter.role, "member:invite")) {
    return { invitation: {} as TeamInvitation, error: "Not authorized to invite" };
  }

  // Validate role
  if (!isValidRole(role)) {
    return { invitation: {} as TeamInvitation, error: "Invalid role" };
  }

  // Check email not already member
  const existing = Array.from(members.values()).find(
    (m) => m.team_id === team_id && m.email === email,
  );
  if (existing && existing.status === "accepted") {
    return { invitation: {} as TeamInvitation, error: "User already member" };
  }

  const invitation: TeamInvitation = {
    id: `inv_${randomUUID()}`,
    team_id,
    email,
    role: role as Role,
    token: randomUUID(),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    accepted_at: null,
  };

  invitations.set(invitation.id, invitation);
  logAudit(team_id, inviter_id, "member_invited", "user", email, email, {
    role,
  });

  return { invitation };
}

/**
 * Accept invitation and join team
 */
export function acceptInvitation(
  invitation_id: string,
  user_id: string,
  email: string,
): { member: TeamMember; error?: string } {
  const invitation = invitations.get(invitation_id);
  if (!invitation) {
    return { member: {} as TeamMember, error: "Invitation not found" };
  }

  if (invitation.email !== email) {
    return { member: {} as TeamMember, error: "Email mismatch" };
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return { member: {} as TeamMember, error: "Invitation expired" };
  }

  const member: TeamMember = {
    id: `mem_${randomUUID()}`,
    team_id: invitation.team_id,
    user_id,
    email,
    role: invitation.role,
    invited_at: invitation.created_at,
    joined_at: new Date().toISOString(),
    status: "accepted",
  };

  members.set(member.id, member);
  invitation.accepted_at = new Date().toISOString();
  logAudit(invitation.team_id, user_id, "member_joined", "user", user_id, email, {
    role: invitation.role,
  });

  return { member };
}

/**
 * List team members
 */
export function listTeamMembers(
  team_id: string,
): { members: TeamMember[]; error?: string } {
  const team = teams.get(team_id);
  if (!team) {
    return { members: [], error: "Team not found" };
  }

  const teamMembers = Array.from(members.values()).filter(
    (m) => m.team_id === team_id && m.status === "accepted",
  );

  return { members: teamMembers };
}

/**
 * Remove member from team
 */
export function removeTeamMember(
  team_id: string,
  member_id: string,
  requester_id: string,
): { success: boolean; error?: string } {
  const team = teams.get(team_id);
  if (!team) {
    return { success: false, error: "Team not found" };
  }

  // Check requester has permission
  const requester = Array.from(members.values()).find(
    (m) => m.team_id === team_id && m.user_id === requester_id,
  );
  if (!requester || !hasPermission(requester.role, "member:remove")) {
    return { success: false, error: "Not authorized to remove members" };
  }

  const member = members.get(member_id);
  if (!member || member.team_id !== team_id) {
    return { success: false, error: "Member not found" };
  }

  // Prevent removing owner
  if (member.role === "owner") {
    return { success: false, error: "Cannot remove team owner" };
  }

  member.status = "revoked";
  logAudit(team_id, requester_id, "member_removed", "user", member.user_id, member.email, {});

  return { success: true };
}

/**
 * Change member role
 */
export function changeTeamMemberRole(
  team_id: string,
  member_id: string,
  new_role: string,
  requester_id: string,
): { success: boolean; error?: string } {
  if (!isValidRole(new_role)) {
    return { success: false, error: "Invalid role" };
  }

  // Check requester has permission
  const requester = Array.from(members.values()).find(
    (m) => m.team_id === team_id && m.user_id === requester_id,
  );
  if (!requester || !hasPermission(requester.role, "member:role_change")) {
    return { success: false, error: "Not authorized to change roles" };
  }

  const member = members.get(member_id);
  if (!member || member.team_id !== team_id) {
    return { success: false, error: "Member not found" };
  }

  const old_role = member.role;
  member.role = new_role as Role;
  logAudit(team_id, requester_id, "member_role_changed", "user", member.user_id, member.email, {
    old_role,
    new_role,
  });

  return { success: true };
}

/**
 * Get audit logs
 */
export function getAuditLogs(
  team_id: string,
  limit = 100,
): { logs: AuditLog[]; total: number } {
  const filtered = auditLogs
    .filter((log) => log.team_id === team_id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  return { logs: filtered, total: auditLogs.filter((l) => l.team_id === team_id).length };
}

/**
 * Log audit event
 */
function logAudit(
  team_id: string,
  user_id: string,
  action: string,
  resource_type: string,
  resource_id: string,
  resource_name: string,
  details: Record<string, unknown>,
): void {
  const log: AuditLog = {
    id: `audit_${randomUUID()}`,
    team_id,
    user_id,
    action: action as any,
    resource_type,
    resource_id,
    resource_name,
    status: "success",
    details,
    timestamp: new Date().toISOString(),
  };

  auditLogs.push(log);
}

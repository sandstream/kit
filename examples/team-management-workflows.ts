/**
 * Team Management Workflow Examples
 *
 * Demonstrates team creation, member management, RBAC, invitations, and
 * multi-team setups for enterprise kit deployments.
 */

import {
  createTeam,
  addTeamMember,
  removeTeamMember,
  updateMemberRole,
  getTeam,
  listTeamMembers,
  grantPermission,
  revokePermission,
  createTeamRole,
  inviteMember,
  acceptInvitation,
  getAuditLog,
  getTeamMetrics,
} from "../dist/team-management-service.js";

// ─── Basic Team Setup ──────────────────────────────────────────────────

/**
 * Example 1: Create a team with initial members
 */
async function createTeamWithMembers() {
  console.log("Creating team...");
  const team = createTeam("Engineering", "user-001", "Core engineering team");

  console.log(`Team created: ${team.team.name} (${team.team.id})`);

  // Add owner
  const owner = addTeamMember(team.team.id, "user-001", "owner");
  console.log(`Owner added: ${owner.member?.user_id}`);

  // Add admin
  const admin = addTeamMember(team.team.id, "user-002", "admin");
  console.log(`Admin added: ${admin.member?.user_id}`);

  // Add members
  const members = ["user-003", "user-004", "user-005"];
  members.forEach((userId) => {
    const result = addTeamMember(team.team.id, userId, "member");
    console.log(`Member added: ${userId}`);
  });

  return team.team;
}

/**
 * Example 2: Manage team membership
 */
async function manageMembership(teamId: string) {
  console.log("Managing team membership...");

  // List current members
  const members = listTeamMembers(teamId);
  console.log(`Current members: ${members.total}`);
  members.members.forEach((m) => {
    console.log(`  - ${m.user_id} (${m.role})`);
  });

  // Promote member
  console.log("\nPromoting user-003 to admin...");
  const promoted = updateMemberRole(teamId, "user-003", "admin");
  console.log(`New role: ${promoted.member?.role}`);

  // Demote member
  console.log("\nDemoting user-004 to guest...");
  const demoted = updateMemberRole(teamId, "user-004", "guest");
  console.log(`New role: ${demoted.member?.role}`);

  // Remove member
  console.log("\nRemoving user-005...");
  const removed = removeTeamMember(teamId, "user-005");
  console.log(`Removed: ${removed.success}`);

  // Verify final count
  const finalMembers = listTeamMembers(teamId);
  console.log(`\nFinal member count: ${finalMembers.total}`);
}

// ─── Role-Based Access Control ────────────────────────────────────────

/**
 * Example 3: Create and assign custom roles
 */
async function setupCustomRoles(teamId: string) {
  console.log("Setting up custom roles...\n");

  // Create Tech Lead role
  const techLeadRole = createTeamRole(teamId, "Tech Lead", [
    "teams:read",
    "teams:write",
    "members:add",
    "members:remove",
    "members:update_role",
    "plugins:install",
    "plugins:configure",
    "workflows:create",
    "workflows:execute",
    "audit:read",
  ]);
  console.log(`Created role: ${techLeadRole.role?.name}`);

  // Create Developer role
  const devRole = createTeamRole(teamId, "Developer", [
    "teams:read",
    "plugins:read",
    "workflows:execute",
  ]);
  console.log(`Created role: ${devRole.role?.name}`);

  // Create QA role
  const qaRole = createTeamRole(teamId, "QA Engineer", [
    "teams:read",
    "workflows:read",
    "workflows:execute",
    "audit:read",
  ]);
  console.log(`Created role: ${qaRole.role?.name}`);

  // Assign members to roles
  grantPermission(teamId, "user-002", "teams:write");
  grantPermission(teamId, "user-002", "members:add");
  console.log(`User-002 granted tech lead permissions`);

  grantPermission(teamId, "user-003", "workflows:execute");
  console.log(`User-003 granted developer permissions`);
}

/**
 * Example 4: Permission management
 */
async function managePermissions(teamId: string) {
  console.log("Managing permissions...\n");

  // Grant permissions
  console.log("Granting permissions...");
  grantPermission(teamId, "user-003", "plugins:install");
  grantPermission(teamId, "user-003", "workflows:create");
  grantPermission(teamId, "user-003", "audit:read", "user-001");
  console.log("Permissions granted to user-003");

  // Revoke specific permission
  console.log("\nRevoking audit:read permission...");
  revokePermission(teamId, "user-003", "audit:read");
  console.log("Permission revoked");

  // Grant time-limited permission
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  console.log(`\nGranting temporary permission (expires tomorrow)...`);
  grantPermission(teamId, "user-004", "plugins:install", "user-001", tomorrow.toISOString());
}

// ─── Invitations & Onboarding ─────────────────────────────────────────

/**
 * Example 5: Send invitations to new team members
 */
async function inviteNewMembers(teamId: string) {
  console.log("Inviting new team members...\n");

  const newEmails = [
    { email: "alice@company.com", role: "member" as const },
    { email: "bob@company.com", role: "member" as const },
    { email: "charlie@company.com", role: "admin" as const },
  ];

  const invitations = [];

  for (const person of newEmails) {
    const inv = inviteMember(teamId, person.email, person.role, "user-001");

    if (inv.invitation) {
      invitations.push(inv.invitation);
      console.log(`Invitation sent to ${person.email}`);
      console.log(`  Role: ${person.role}`);
      console.log(`  Token: ${inv.invitation.token?.substring(0, 20)}...`);
      console.log(`  Expires: ${inv.invitation.expires_at}\n`);
    }
  }

  return invitations;
}

/**
 * Example 6: Accept invitation flow
 */
async function acceptInvitationFlow(invitationId: string, userId: string) {
  console.log(`User ${userId} accepting invitation...\n`);

  const result = acceptInvitation(invitationId, userId);

  if (result.member) {
    console.log(`✓ Welcome to the team!`);
    console.log(`  User: ${result.member.user_id}`);
    console.log(`  Role: ${result.member.role}`);
    console.log(`  Team: ${result.member.team_id}`);
  } else {
    console.log(`✗ Failed: ${result.error}`);
  }
}

// ─── Multi-Team Organization ──────────────────────────────────────────

/**
 * Example 7: Create multi-team organization
 */
async function createOrganization() {
  console.log("Creating multi-team organization...\n");

  // Create main team (company)
  const company = createTeam("Acme Corp", "ceo-001", "Company organization");
  console.log(`Created: ${company.team.name}`);

  // Create department teams
  const departments = ["Engineering", "Operations", "Sales", "Design"];
  const teamMap: Record<string, string> = {};

  for (const dept of departments) {
    const team = createTeam(dept, "ceo-001", `${dept} department`);
    teamMap[dept] = team.team.id;
    console.log(`Created: ${dept} (${team.team.id})`);
  }

  // Add leads to each department
  const leads = {
    Engineering: "eng-lead-001",
    Operations: "ops-lead-001",
    Sales: "sales-lead-001",
    Design: "design-lead-001",
  };

  for (const [dept, leadId] of Object.entries(leads)) {
    addTeamMember(teamMap[dept], leadId, "admin");
    console.log(`Added ${leadId} as lead of ${dept}`);
  }

  return teamMap;
}

/**
 * Example 8: Cross-team member with different roles
 */
async function assignCrossTeamRoles(teamMap: Record<string, string>, userId: string) {
  console.log(`\nAssigning cross-team roles for ${userId}...\n`);

  // User is dev in Engineering, but admin of shared services
  addTeamMember(teamMap["Engineering"], userId, "member");
  console.log(`${userId}: member of Engineering`);

  // User manages shared infrastructure
  addTeamMember(teamMap["Operations"], userId, "admin");
  console.log(`${userId}: admin of Operations`);

  // User has read-only access to Sales
  addTeamMember(teamMap["Sales"], userId, "guest");
  console.log(`${userId}: guest access to Sales`);

  // Effective permissions = union of all team roles
  console.log(`\nEffective permissions:`);
  console.log(`  - Execute workflows (Engineering member)`);
  console.log(`  - Manage infrastructure (Operations admin)`);
  console.log(`  - Read sales data (Sales guest)`);
}

// ─── Audit & Compliance ───────────────────────────────────────────────

/**
 * Example 9: Review audit log for compliance
 */
async function auditTeamActivity(teamId: string) {
  console.log("Reviewing team audit log...\n");

  const auditLog = getAuditLog(teamId, 20, 0);

  console.log(`Total events: ${auditLog.total}`);
  console.log(`Showing latest 20:\n`);

  auditLog.logs.forEach((log, i) => {
    console.log(`${i + 1}. [${log.timestamp}] ${log.actor_name} ${log.action} ${log.resource}`);
    console.log(`   Resource ID: ${log.resource_id}`);
    console.log(`   Status: ${log.status}`);
    if (log.details) {
      console.log(`   Details: ${JSON.stringify(log.details)}`);
    }
  });
}

/**
 * Example 10: Team metrics and health check
 */
async function checkTeamHealth(teamId: string) {
  console.log("Checking team health...\n");

  const metrics = getTeamMetrics(teamId);

  if (metrics.metrics) {
    const m = metrics.metrics;
    console.log(`Team Metrics:`);
    console.log(`  Total members: ${m.total_members}`);
    console.log(`  Active (7d): ${m.active_members_7d}`);
    console.log(`  Pending invitations: ${m.invitation_pending}`);
    console.log(`  Total permissions: ${m.total_permissions}`);
    console.log(`  Recent audit events: ${m.recent_audit_events}`);

    // Calculate health score
    const healthPercent = Math.round((m.active_members_7d / m.total_members) * 100);
    const health = healthPercent > 80 ? "✓ Healthy" : "⚠ Needs attention";
    console.log(`\nTeam Health: ${health} (${healthPercent}% active)`);
  }
}

// ─── Complete Workflows ───────────────────────────────────────────────

/**
 * Example 11: Full team onboarding workflow
 */
async function fullOnboardingWorkflow() {
  console.log("=== Full Team Onboarding Workflow ===\n");

  // Step 1: Create team
  console.log("Step 1: Creating team...");
  const team = createTeam("kit Team", "founder-001");
  const teamId = team.team.id;
  console.log(`✓ Team created: ${teamId}\n`);

  // Step 2: Add founder
  console.log("Step 2: Adding founder...");
  addTeamMember(teamId, "founder-001", "owner");
  console.log("✓ Owner added\n");

  // Step 3: Create custom roles
  console.log("Step 3: Setting up custom roles...");
  const techLead = createTeamRole(teamId, "Tech Lead", [
    "teams:read",
    "teams:write",
    "members:add",
    "workflows:create",
    "plugins:install",
  ]);
  console.log(`✓ Role created: ${techLead.role?.name}\n`);

  // Step 4: Send invitations
  console.log("Step 4: Inviting team members...");
  const inv1 = inviteMember(teamId, "alice@startup.com", "admin");
  const inv2 = inviteMember(teamId, "bob@startup.com", "member");
  console.log("✓ Invitations sent\n");

  // Step 5: Accept invitations (simulated)
  console.log("Step 5: Members joining...");
  if (inv1.invitation) {
    acceptInvitation(inv1.invitation.id, "alice-user-id");
  }
  if (inv2.invitation) {
    acceptInvitation(inv2.invitation.id, "bob-user-id");
  }
  console.log("✓ Members joined\n");

  // Step 6: Configure permissions
  console.log("Step 6: Assigning permissions...");
  grantPermission(teamId, "alice-user-id", "members:add");
  grantPermission(teamId, "bob-user-id", "workflows:execute");
  console.log("✓ Permissions configured\n");

  // Step 7: Verify setup
  console.log("Step 7: Verifying setup...");
  const members = listTeamMembers(teamId);
  const metrics = getTeamMetrics(teamId);
  console.log(
    `✓ Team ready: ${members.total} members, ${metrics.metrics?.total_permissions} permissions`,
  );
}

// ─── Export Examples ──────────────────────────────────────────────────

export {
  createTeamWithMembers,
  manageMembership,
  setupCustomRoles,
  managePermissions,
  inviteNewMembers,
  acceptInvitationFlow,
  createOrganization,
  assignCrossTeamRoles,
  auditTeamActivity,
  checkTeamHealth,
  fullOnboardingWorkflow,
};

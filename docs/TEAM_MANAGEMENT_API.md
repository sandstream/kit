# Team Management API Documentation

Comprehensive guide for kit team management with RBAC, invitations, and audit logging.

## Overview

Team Management provides:
- **Multi-team support** with ownership and member roles
- **Role-Based Access Control (RBAC)** with 4 predefined roles + custom roles
- **Invitations** with email and expiration
- **Audit logging** for compliance and security
- **Team metrics** and activity tracking

## Core Concepts

### Roles Hierarchy

| Role | Priority | Permissions |
|------|----------|-------------|
| Owner | 4 | All (full admin) |
| Admin | 3 | Team config, members, invites |
| Member | 2 | Basic access, limited modifications |
| Guest | 1 | Read-only access |
| Custom | 1-4 | Configurable permissions |

### Team Lifecycle

```
Create Team → Add Members → Configure Roles → Grant Permissions → Audit
```

---

## API Reference

### Team Management

#### Create Team
```typescript
createTeam(
  name: string,
  owner_id: string,
  description?: string,
  settings?: Record<string, unknown>
): { team: Team; error?: string }
```

**Example**
```typescript
const team = createTeam("Engineering", "user-123", "Core dev team");
// Returns: { name: "Engineering", slug: "engineering", owner_id: "user-123", ... }
```

#### Get Team
```typescript
getTeam(team_id: string): { team: Team | null; error?: string }
```

#### List Teams
```typescript
listTeams(
  owner_id?: string,
  limit?: number,
  offset?: number
): { teams: Team[]; total: number }
```

### Member Management

#### Add Team Member
```typescript
addTeamMember(
  team_id: string,
  user_id: string,
  role: "owner" | "admin" | "member" | "guest",
  added_by?: string
): { member: TeamMember; error?: string }
```

**Example**
```typescript
const member = addTeamMember("team-123", "user-456", "member");
// Automatically assigns RBAC role based on team role
```

#### Remove Team Member
```typescript
removeTeamMember(
  team_id: string,
  user_id: string,
  removed_by?: string
): { success: boolean; error?: string }
```

#### Update Member Role
```typescript
updateMemberRole(
  team_id: string,
  user_id: string,
  role: "owner" | "admin" | "member" | "guest",
  updated_by?: string
): { member: TeamMember; error?: string }
```

#### List Team Members
```typescript
listTeamMembers(
  team_id: string,
  limit?: number,
  offset?: number
): { members: TeamMember[]; total: number; error?: string }
```

### Permissions

#### Grant Permission
```typescript
grantPermission(
  team_id: string,
  user_id: string,
  permission: string,
  granted_by?: string,
  expires_at?: string
): { permission: Permission; error?: string }
```

**Common Permissions**
- `teams:read`, `teams:write`, `teams:delete`
- `members:add`, `members:remove`, `members:update_role`
- `plugins:install`, `plugins:configure`, `plugins:uninstall`
- `workflows:create`, `workflows:execute`, `workflows:delete`
- `audit:read`, `audit:export`

#### Revoke Permission
```typescript
revokePermission(
  team_id: string,
  user_id: string,
  permission: string,
  revoked_by?: string
): { success: boolean; error?: string }
```

### Invitations

#### Invite Member
```typescript
inviteMember(
  team_id: string,
  email: string,
  role: "admin" | "member" | "guest",
  invited_by?: string
): { invitation: TeamInvitation; error?: string }
```

**Example**
```typescript
const invite = inviteMember("team-123", "newmember@company.com", "member");
// Returns invitation with expiration (7 days)
// Share invitation.token with user
```

#### Accept Invitation
```typescript
acceptInvitation(
  invitation_id: string,
  user_id: string
): { member: TeamMember; error?: string }
```

### Roles & Permissions

#### Create Custom Role
```typescript
createTeamRole(
  team_id: string,
  name: string,
  permissions: string[],
  created_by?: string
): { role: TeamRole; error?: string }
```

**Example**
```typescript
const role = createTeamRole("team-123", "DevOps", [
  "teams:read",
  "workflows:execute",
  "audit:read"
]);
```

### Audit & Metrics

#### Get Team Audit Log
```typescript
getAuditLog(
  team_id: string,
  limit?: number,
  offset?: number
): { logs: TeamAuditLog[]; total: number; error?: string }
```

#### Get Team Metrics
```typescript
getTeamMetrics(team_id: string): { metrics: TeamMetrics; error?: string }
```

**Returns**
```typescript
{
  total_members: number;
  active_members_7d: number;
  total_permissions: number;
  recent_audit_events: number;
  invitation_pending: number;
}
```

---

## Multi-Team Setup Examples

### Example 1: Create Multi-Team Organization

```typescript
// Create root team (company)
const company = createTeam("Acme Corp", "ceo-001");

// Create sub-teams
const engineering = createTeam("Engineering", "ceo-001", "Dev team");
const ops = createTeam("Operations", "ceo-001", "DevOps team");
const sales = createTeam("Sales", "ceo-001", "Sales team");

// Add members to engineering
addTeamMember(engineering.team.id, "eng-lead-001", "admin");
addTeamMember(engineering.team.id, "engineer-001", "member");
addTeamMember(engineering.team.id, "engineer-002", "member");

// Add members to ops
addTeamMember(ops.team.id, "ops-lead-001", "admin");
addTeamMember(ops.team.id, "devops-001", "member");
```

### Example 2: Role-Based Access Control

```typescript
// Create custom roles per team
const engineeringRoles = {
  tech_lead: createTeamRole(engineering.id, "Tech Lead", [
    "teams:read",
    "teams:write",
    "members:add",
    "members:remove",
    "workflows:create",
    "workflows:execute",
    "plugins:install",
    "audit:read"
  ]),
  developer: createTeamRole(engineering.id, "Developer", [
    "teams:read",
    "workflows:execute",
    "plugins:read"
  ]),
  intern: createTeamRole(engineering.id, "Intern", [
    "teams:read",
    "workflows:read"
  ])
};

// Assign members to custom roles
grantPermission(engineering.id, "engineer-001", "workflows:execute");
grantPermission(engineering.id, "engineer-001", "plugins:read");
```

### Example 3: Bulk Invitations

```typescript
const newEmployees = [
  { email: "alice@company.com", role: "member" },
  { email: "bob@company.com", role: "member" },
  { email: "charlie@company.com", role: "guest" }
];

const invitations = newEmployees.map(emp => 
  inviteMember(team.id, emp.email, emp.role)
);

// Share invitations
invitations.forEach(inv => {
  if (inv.invitation) {
    sendEmail(inv.invitation.email, {
      subject: "Join our kit team",
      body: `Accept invitation: kit://accept/${inv.invitation.token}`
    });
  }
});
```

### Example 4: Cross-Team Permissions

```typescript
// User has access to multiple teams
const user = "engineer-001";

// Grant different roles in different teams
addTeamMember(engineering.id, user, "member");    // Regular dev in engineering
addTeamMember(devtools.id, user, "admin");        // Admin of devtools team
addTeamMember(infra.id, user, "guest");           // Read-only in infra

// User's effective permissions are union of all team roles
// Can execute workflows in engineering + devtools
// Can read audit logs in infra
```

### Example 5: Audit & Compliance

```typescript
// Get audit trail for compliance review
const teamAudit = getAuditLog(engineering.id);
// Returns all member additions, removals, permission changes

// Export metrics for reporting
const metrics = getTeamMetrics(engineering.id);
console.log(`Team Size: ${metrics.total_members}`);
console.log(`Active (7d): ${metrics.active_members_7d}`);
console.log(`Pending Invites: ${metrics.invitation_pending}`);
console.log(`Recent Events: ${metrics.recent_audit_events}`);
```

### Example 6: Dynamic Team Creation

```typescript
async function setupProjectTeam(projectName: string, leads: string[]) {
  // Create team per project
  const team = createTeam(projectName, "admin-001");
  
  // Add team lead(s)
  const leadRole = createTeamRole(team.id, "Project Lead", [
    "teams:read",
    "teams:write",
    "members:add",
    "members:remove",
    "workflows:create",
    "workflows:execute"
  ]);
  
  leads.forEach(leadId => {
    addTeamMember(team.id, leadId, "admin");
    grantPermission(team.id, leadId, "teams:write");
  });
  
  return team;
}

// Usage
const projectTeam = setupProjectTeam("Project Alpha", [
  "alice-001",
  "bob-001"
]);
```

---

## Error Handling

```typescript
// All functions return error in response
const result = addTeamMember(teamId, userId, "member");

if (result.error) {
  console.error("Failed to add member:", result.error);
  // "Team 'xyz' not found"
  // "User 'abc' already member of team"
  // "Invalid role: superadmin"
  return;
}

const member = result.member;
```

---

## Pagination

List functions support pagination:

```typescript
const page1 = listTeamMembers(teamId, limit: 10, offset: 0);
const page2 = listTeamMembers(teamId, limit: 10, offset: 10);

console.log(`Total: ${page1.total}, Page 1: ${page1.members.length}`);
```

---

## Audit Trail Events

All operations logged:
- Member added/removed
- Role changed
- Permission granted/revoked
- Invitation sent/accepted
- Custom role created
- Team settings updated

Each audit entry includes: timestamp, actor_id, action, resource, status

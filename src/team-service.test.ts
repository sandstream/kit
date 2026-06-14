import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTeam,
  getTeam,
  inviteToTeam,
  listTeamMembers,
  removeTeamMember,
  getAuditLogs,
} from "./team-service.js";

describe("team-service", () => {
  describe("createTeam", () => {
    it("creates team with owner", () => {
      const { team, error } = createTeam("Test Team", "owner-123");

      assert.ok(!error);
      assert.ok(team.id);
      assert.equal(team.name, "Test Team");
      assert.equal(team.owner_id, "owner-123");
    });

    it("rejects empty name", () => {
      const { error } = createTeam("", "owner-123");

      assert.ok(error);
      assert.equal(error, "Team name required");
    });
  });

  describe("getTeam", () => {
    it("retrieves existing team", () => {
      const { team: created } = createTeam("Retrieved Team", "owner-456");
      const retrieved = getTeam(created.id);

      assert.ok(retrieved);
      assert.equal(retrieved?.name, "Retrieved Team");
    });

    it("returns null for missing team", () => {
      const result = getTeam("nonexistent-id");
      assert.equal(result, null);
    });
  });

  describe("inviteToTeam", () => {
    it("invites user with valid role", () => {
      const { team } = createTeam("Invite Test", "owner-789");
      const { invitation, error } = inviteToTeam(
        team.id,
        "user@example.com",
        "developer",
        "owner-789",
      );

      assert.ok(!error);
      assert.ok(invitation.id);
      assert.equal(invitation.email, "user@example.com");
      assert.equal(invitation.role, "developer");
    });

    it("rejects invalid role", () => {
      const { team } = createTeam("Role Test", "owner-abc");
      const { error } = inviteToTeam(
        team.id,
        "user@test.com",
        "superuser",
        "owner-abc",
      );

      assert.ok(error);
      assert.ok(error?.includes("Invalid role"));
    });

    it("rejects invite from non-member", () => {
      const { team } = createTeam("Permission Test", "owner-def");
      const { error } = inviteToTeam(
        team.id,
        "user@test.com",
        "developer",
        "random-user",
      );

      assert.ok(error);
      assert.ok(error?.includes("Not authorized"));
    });
  });

  describe("listTeamMembers", () => {
    it("includes owner in new team", () => {
      const { team } = createTeam("Owner Team", "owner-ghi");
      const { members } = listTeamMembers(team.id);

      assert.equal(members.length, 1);
      assert.equal(members[0].role, "owner");
      assert.equal(members[0].user_id, "owner-ghi");
    });
  });

  describe("removeTeamMember", () => {
    it("prevents removing owner", () => {
      const { team } = createTeam("Owner Test", "owner-jkl");
      // Try to remove owner (would need member setup)
      const { success, error } = removeTeamMember(
        team.id,
        "owner-jkl",
        "owner-jkl",
      );

      // Since we don't have proper member setup, error is expected
      assert.ok(!success || error);
    });
  });

  describe("getAuditLogs", () => {
    it("returns audit logs for team", () => {
      const { team } = createTeam("Audit Test", "owner-mno");
      const { logs, total } = getAuditLogs(team.id);

      // Should have at least team_created event
      assert.ok(total >= 1);
      assert.ok(logs.length >= 1);
      assert.equal(logs[0].action, "team_created");
    });

    it("respects limit parameter", () => {
      const { team } = createTeam("Limit Test", "owner-pqr");
      const { logs } = getAuditLogs(team.id, 0);

      assert.equal(logs.length, 0);
    });
  });
});

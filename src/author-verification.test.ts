import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AuthorVerificationSystem } from "./author-verification.js";

describe("AuthorVerificationSystem", () => {
  describe("initialization", () => {
    it("creates system instance", () => {
      const system = new AuthorVerificationSystem();
      assert(system);
    });

    it("returns null for unknown author", () => {
      const system = new AuthorVerificationSystem();
      assert.equal(system.getVerification("unknown"), null);
    });
  });

  describe("startVerification", () => {
    let system: AuthorVerificationSystem;

    beforeEach(() => {
      system = new AuthorVerificationSystem();
    });

    it("creates a new verification record", () => {
      const record = system.startVerification("author-1");
      assert.equal(record.authorId, "author-1");
      assert.equal(record.status, "pending");
      assert.deepEqual(record.completedSteps, []);
    });

    it("returns existing record if pending", () => {
      const first = system.startVerification("author-1");
      const second = system.startVerification("author-1");
      assert.equal(first.createdAt, second.createdAt);
    });

    it("includes required steps", () => {
      const record = system.startVerification("author-1");
      assert(record.steps.includes("github"));
      assert(record.steps.includes("email"));
      assert(record.steps.includes("cla"));
    });
  });

  describe("GitHub verification", () => {
    let system: AuthorVerificationSystem;

    beforeEach(() => {
      system = new AuthorVerificationSystem();
      system.startVerification("author-1");
    });

    it("generates GitHub OAuth state", () => {
      const state = system.generateGitHubState("author-1");
      assert(state);
      assert(typeof state === "string");
    });

    it("parses GitHub state back to authorId", () => {
      const state = system.generateGitHubState("author-1");
      const parsed = system.parseGitHubState(state);
      assert(parsed);
      assert.equal(parsed.authorId, "author-1");
    });

    it("returns null for invalid state", () => {
      const result = system.parseGitHubState("invalid-state");
      assert.equal(result, null);
    });

    it("completes GitHub verification", async () => {
      const result = await system.completeGitHubVerification("author-1", {
        id: "gh-123",
        login: "janedoe",
        name: "Jane Doe",
      });

      assert.equal(result.success, true);
      assert.equal(result.step, "github");
      assert(result.message.includes("janedoe"));
    });

    it("marks github step as completed", async () => {
      await system.completeGitHubVerification("author-1", {
        id: "gh-123",
        login: "janedoe",
      });

      assert.equal(system.isStepComplete("author-1", "github"), true);
    });

    it("saves github data on record", async () => {
      await system.completeGitHubVerification("author-1", {
        id: "gh-123",
        login: "janedoe",
        name: "Jane Doe",
        avatar_url: "https://github.com/janedoe.png",
      });

      const record = system.getVerification("author-1");
      assert(record?.github);
      assert.equal(record?.github?.githubLogin, "janedoe");
      assert.equal(record?.github?.githubId, "gh-123");
    });

    it("rejects duplicate GitHub account", async () => {
      system.startVerification("author-2");
      await system.completeGitHubVerification("author-2", {
        id: "gh-999",
        login: "shared_account",
      });

      const result = await system.completeGitHubVerification("author-1", {
        id: "gh-999",
        login: "shared_account",
      });

      assert.equal(result.success, false);
      assert(result.message.includes("already linked"));
    });

    it("provides next step after github", async () => {
      const result = await system.completeGitHubVerification("author-1", {
        id: "gh-123",
        login: "janedoe",
      });

      assert(result.nextStep);
      assert.equal(result.nextStep, "email");
    });
  });

  describe("email verification", () => {
    let system: AuthorVerificationSystem;

    beforeEach(() => {
      system = new AuthorVerificationSystem();
      system.startVerification("author-1");
    });

    it("generates email verification token", () => {
      const token = system.generateEmailToken("author-1", "dev@example.com");
      assert(token);
      assert(typeof token === "string");
      assert(token.length > 0);
    });

    it("verifies valid email token", async () => {
      const token = system.generateEmailToken("author-1", "dev@example.com");
      const result = await system.verifyEmailToken(token, "dev@example.com");

      assert.equal(result.success, true);
      assert.equal(result.step, "email");
      assert(result.message.includes("dev@example.com"));
    });

    it("marks email step as completed", async () => {
      const token = system.generateEmailToken("author-1", "dev@example.com");
      await system.verifyEmailToken(token, "dev@example.com");

      assert.equal(system.isStepComplete("author-1", "email"), true);
    });

    it("saves email domain on record", async () => {
      const token = system.generateEmailToken("author-1", "dev@example.com");
      await system.verifyEmailToken(token, "dev@example.com");

      const record = system.getVerification("author-1");
      assert.equal(record?.email?.domain, "example.com");
    });

    it("rejects invalid token", async () => {
      const result = await system.verifyEmailToken("invalid-token", "test@example.com");
      assert.equal(result.success, false);
      assert(result.message.includes("Invalid"));
    });

    it("rejects already-used token", async () => {
      const token = system.generateEmailToken("author-1", "dev@example.com");
      await system.verifyEmailToken(token, "dev@example.com");

      const result2 = await system.verifyEmailToken(token, "dev@example.com");
      assert.equal(result2.success, false);
      assert(result2.message.includes("already been used"));
    });
  });

  describe("CLA signing", () => {
    let system: AuthorVerificationSystem;

    beforeEach(() => {
      system = new AuthorVerificationSystem();
      system.startVerification("author-1");
    });

    it("signs CLA successfully", async () => {
      const result = await system.signCLA("author-1", "v1.0");
      assert.equal(result.success, true);
      assert.equal(result.step, "cla");
      assert(result.message.includes("v1.0"));
    });

    it("marks cla step as completed", async () => {
      await system.signCLA("author-1", "v1.0");
      assert.equal(system.isStepComplete("author-1", "cla"), true);
    });

    it("saves CLA data on record", async () => {
      await system.signCLA("author-1", "v1.0", "192.168.1.1");
      const record = system.getVerification("author-1");
      assert.equal(record?.cla?.version, "v1.0");
      assert.equal(record?.cla?.ipAddress, "192.168.1.1");
    });

    it("fails if verification not started", async () => {
      const result = await system.signCLA("non-existent", "v1.0");
      assert.equal(result.success, false);
    });

    it("auto-verifies when all steps complete", async () => {
      // Complete all steps
      await system.completeGitHubVerification("author-1", {
        id: "gh-1",
        login: "user",
      });
      const token = system.generateEmailToken("author-1", "user@example.com");
      await system.verifyEmailToken(token, "user@example.com");
      const result = await system.signCLA("author-1", "v1.0");

      assert.equal(result.record?.status, "verified");
    });
  });

  describe("publisher verification", () => {
    let system: AuthorVerificationSystem;

    beforeEach(async () => {
      system = new AuthorVerificationSystem();
      system.startVerification("author-1");
      // Complete all base steps
      await system.completeGitHubVerification("author-1", {
        id: "gh-1",
        login: "user",
      });
      const token = system.generateEmailToken("author-1", "user@example.com");
      await system.verifyEmailToken(token, "user@example.com");
      await system.signCLA("author-1", "v1.0");
    });

    it("approves publisher for verified author", async () => {
      const result = await system.approvePublisher("author-1", "admin-user");
      assert.equal(result.success, true);
      assert.equal(result.step, "publisher");
    });

    it("marks publisher step as completed", async () => {
      await system.approvePublisher("author-1", "admin-user");
      assert.equal(system.isPublisherVerified("author-1"), true);
    });

    it("saves publisher approval data", async () => {
      await system.approvePublisher("author-1", "admin-user");
      const record = system.getVerification("author-1");
      assert(record?.publisherApprovedAt);
      assert.equal(record?.publisherApprovedBy, "admin-user");
    });

    it("fails for unverified author", async () => {
      system.startVerification("author-2");
      const result = await system.approvePublisher("author-2", "admin");
      assert.equal(result.success, false);
      assert(result.message.includes("basic verification"));
    });

    it("fails for unknown author", async () => {
      const result = await system.approvePublisher("unknown", "admin");
      assert.equal(result.success, false);
    });
  });

  describe("progress tracking", () => {
    let system: AuthorVerificationSystem;

    beforeEach(() => {
      system = new AuthorVerificationSystem();
    });

    it("returns zero progress for new author", () => {
      system.startVerification("author-1");
      const progress = system.getVerificationProgress("author-1");

      assert.equal(progress.completed, 0);
      assert.equal(progress.percent, 0);
      assert.equal(progress.nextStep, "github");
    });

    it("returns correct progress after each step", async () => {
      system.startVerification("author-1");

      await system.completeGitHubVerification("author-1", {
        id: "gh-1",
        login: "user",
      });

      const progress = system.getVerificationProgress("author-1");
      assert.equal(progress.completed, 1);
      assert(progress.percent > 0);
      assert.equal(progress.nextStep, "email");
    });

    it("returns null nextStep when all done", async () => {
      system.startVerification("author-1");
      await system.completeGitHubVerification("author-1", { id: "gh-1", login: "u" });
      const token = system.generateEmailToken("author-1", "u@e.com");
      await system.verifyEmailToken(token, "u@e.com");
      await system.signCLA("author-1", "v1.0");

      const progress = system.getVerificationProgress("author-1");
      assert.equal(progress.percent, 100);
      assert.equal(progress.nextStep, null);
    });

    it("isPublisherVerified returns false without publisher step", async () => {
      system.startVerification("author-1");
      assert.equal(system.isPublisherVerified("author-1"), false);
    });

    it("isPublisherVerified returns false for unknown author", () => {
      assert.equal(system.isPublisherVerified("unknown"), false);
    });
  });
});

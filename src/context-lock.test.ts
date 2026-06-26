import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareContext,
  parseGithubRemote,
  parseGitlabRemote,
  parseBitbucketRemote,
  parseRemoteHost,
  parseSshCommandIdentity,
  parseSshConfigIdentity,
  parseKeygenFingerprint,
  planContext,
  applyContext,
  parseGcloudProject,
  suggestContextToml,
  hasLockableContext,
  clerkEnvFromKey,
  type LiveContext,
} from "./context-lock.js";

describe("context lock", () => {
  it("passes only when the exact declared pair matches", () => {
    const declared = { gcloud: { account: "ops@example.com", project: "prod-project" } };
    const live: LiveContext = { gcloud: { account: "ops@example.com", project: "prod-project" } };
    const f = compareContext(declared, live);
    assert.equal(f.filter((x) => x.status !== "ok").length, 0);
  });

  it("flags right account + WRONG project as a mismatch (never trust the ambient pair)", () => {
    const declared = { gcloud: { account: "ops@example.com", project: "prod-project" } };
    const live: LiveContext = { gcloud: { account: "ops@example.com", project: "other-project" } };
    const proj = compareContext(declared, live).find(
      (x) => x.tool === "gcloud" && x.field === "project",
    );
    assert.equal(proj?.status, "mismatch");
    assert.equal(proj?.expected, "prod-project");
    assert.equal(proj?.actual, "other-project");
  });

  it("marks unreadable live state as unknown (does not block)", () => {
    const declared = { npm: { registry: "https://registry.npmjs.org" } };
    const live: LiveContext = { npm: { registry: null } };
    assert.equal(compareContext(declared, live)[0]?.status, "unknown");
  });

  it("only checks declared fields", () => {
    const declared = { git: { email: "dev@example.com" } };
    const live: LiveContext = {
      gcloud: { account: "x", project: "y" },
      git: { email: "dev@example.com" },
    };
    const f = compareContext(declared, live);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.tool, "git");
    assert.equal(f[0]?.status, "ok");
  });

  it("flags a vercel link to the wrong project", () => {
    const declared = { vercel: { team: "team_example", project: "prj_canonical" } };
    const live: LiveContext = { vercel: { orgId: "team_example", projectId: "prj_stale" } };
    const proj = compareContext(declared, live).find((x) => x.field === "project(projectId)");
    assert.equal(proj?.status, "mismatch");
  });

  it("parses github org + remote from ssh and https urls", () => {
    assert.deepEqual(parseGithubRemote("git@github.com:example-org/example-repo.git"), {
      org: "example-org",
      remote: "github.com/example-org/example-repo",
    });
    assert.deepEqual(parseGithubRemote("https://github.com/example-org/example-repo"), {
      org: "example-org",
      remote: "github.com/example-org/example-repo",
    });
    assert.deepEqual(parseGithubRemote(null), { org: null, remote: null });
    assert.deepEqual(parseGithubRemote("https://gitlab.com/x/y"), { org: null, remote: null });
  });

  it("parses gitlab group + remote (incl. subgroups), and ignores non-gitlab hosts", () => {
    assert.deepEqual(parseGitlabRemote("git@gitlab.com:acme/team/web.git"), {
      group: "acme",
      remote: "gitlab.com/acme/team/web",
    });
    assert.deepEqual(parseGitlabRemote("https://gitlab.com/acme/web"), {
      group: "acme",
      remote: "gitlab.com/acme/web",
    });
    assert.deepEqual(parseGitlabRemote("git@github.com:acme/web.git"), {
      group: null,
      remote: null,
    });
  });

  it("parses bitbucket workspace + remote, and ignores non-bitbucket hosts", () => {
    assert.deepEqual(parseBitbucketRemote("git@bitbucket.org:acme/web.git"), {
      workspace: "acme",
      remote: "bitbucket.org/acme/web",
    });
    assert.deepEqual(parseBitbucketRemote("https://x@bitbucket.org/acme/web"), {
      workspace: "acme",
      remote: "bitbucket.org/acme/web",
    });
    assert.deepEqual(parseBitbucketRemote("https://github.com/acme/web"), {
      workspace: null,
      remote: null,
    });
  });

  it("locks a gitlab group: only the declared group passes (wrong group = mismatch)", () => {
    const declared = { gitlab: { group: "acme" } };
    assert.equal(
      compareContext(declared, { gitlab: { group: "acme", remote: null } })[0]?.status,
      "ok",
    );
    assert.equal(
      compareContext(declared, { gitlab: { group: "evil", remote: null } })[0]?.status,
      "mismatch",
    );
    assert.equal(
      compareContext(declared, { gitlab: { group: null, remote: null } })[0]?.status,
      "unknown",
    );
  });

  it("locks a bitbucket workspace: only the declared workspace passes", () => {
    const declared = { bitbucket: { workspace: "acme" } };
    assert.equal(
      compareContext(declared, { bitbucket: { workspace: "acme", remote: null } })[0]?.status,
      "ok",
    );
    assert.equal(
      compareContext(declared, { bitbucket: { workspace: "other", remote: null } })[0]?.status,
      "mismatch",
    );
  });

  it("parses the SSH identity from core.sshCommand, ssh -G output, and a keygen fingerprint", () => {
    assert.equal(
      parseSshCommandIdentity("ssh -i ~/.ssh/id_work -o IdentitiesOnly=yes"),
      "~/.ssh/id_work",
    );
    assert.equal(
      parseSshCommandIdentity('ssh -i "/home/me/.ssh/id work"'),
      "/home/me/.ssh/id work",
    );
    assert.equal(parseSshCommandIdentity("ssh"), null);
    assert.equal(
      parseSshConfigIdentity(
        "user me\nidentityfile /home/me/.ssh/id_work\nidentityfile ~/.ssh/id_rsa",
      ),
      "/home/me/.ssh/id_work",
    );
    assert.equal(
      parseKeygenFingerprint("256 SHA256:abc123DEF+/ me@host (ED25519)"),
      "SHA256:abc123DEF+/",
    );
    assert.equal(parseKeygenFingerprint("not a fingerprint"), null);
  });

  it("parses the literal remote host (the Host alias when one is used)", () => {
    assert.equal(parseRemoteHost("git@github.com-work:acme/web.git"), "github.com-work");
    assert.equal(parseRemoteHost("https://gitlab.com/acme/web"), "gitlab.com");
    assert.equal(parseRemoteHost(null), null);
  });

  it("locks the SSH identity: wrong key/fingerprint/host-alias is a mismatch, missing is unknown", () => {
    const byFp = { ssh: { fingerprint: "SHA256:GOOD" } };
    assert.equal(
      compareContext(byFp, {
        ssh: { identity: null, fingerprint: "SHA256:GOOD", host_alias: null },
      })[0]?.status,
      "ok",
    );
    assert.equal(
      compareContext(byFp, {
        ssh: { identity: null, fingerprint: "SHA256:EVIL", host_alias: null },
      })[0]?.status,
      "mismatch",
    );
    assert.equal(
      compareContext(byFp, { ssh: { identity: null, fingerprint: null, host_alias: null } })[0]
        ?.status,
      "unknown",
    );
    const byAlias = { ssh: { host_alias: "github.com-work" } };
    assert.equal(
      compareContext(byAlias, {
        ssh: { identity: null, fingerprint: null, host_alias: "github.com-personal" },
      })[0]?.status,
      "mismatch",
    );
  });

  it("plans gcloud + git activation from the declared context (local config only)", () => {
    const steps = planContext({
      gcloud: {
        config: "prod-cfg",
        account: "ops@example.com",
        project: "prod-project",
        region: "europe-west4",
      },
      git: { email: "dev@example.com" },
    });
    const describes = steps.map((s) => s.describe);
    assert.ok(describes.some((d) => d.includes("activate config prod-cfg")));
    assert.ok(describes.some((d) => d.includes("project=prod-project")));
    assert.ok(describes.some((d) => d.includes("account=ops@example.com")));
    // git identity is repo-local, not global
    const gitStep = steps.find((s) => s.tool === "git");
    assert.equal(gitStep?.local, true);
    assert.deepEqual(gitStep?.argv, ["config", "user.email", "dev@example.com"]);
    // nothing planned for vercel/npm (no clean per-repo activation)
    assert.equal(
      steps.some((s) => s.tool === "vercel" || s.tool === "npm"),
      false,
    );
  });

  it("plans nothing when no activatable context is declared", () => {
    assert.deepEqual(planContext({ npm: { registry: "https://registry.npmjs.org" } }), []);
  });

  it("parses the gcloud project from a config INI", () => {
    assert.equal(
      parseGcloudProject("[core]\naccount = a@b.com\nproject = prod-project\n"),
      "prod-project",
    );
    assert.equal(parseGcloudProject("[core]\naccount = a@b.com\n"), null);
  });

  describe("hasLockableContext", () => {
    it("is true when an account/project binding (gcloud/vercel/github) is present", () => {
      assert.equal(hasLockableContext({ gcloud: { account: "ops@x.com", project: null } }), true);
      assert.equal(hasLockableContext({ vercel: { orgId: null, projectId: "prj_123" } }), true);
      assert.equal(hasLockableContext({ github: { org: "sandstream", remote: null } }), true);
    });
    it("is false for git-email / npm-registry only (low contamination risk, too noisy to prompt)", () => {
      assert.equal(
        hasLockableContext({
          git: { email: "a@b.com" },
          npm: { registry: "https://registry.npmjs.org" },
        }),
        false,
      );
      assert.equal(hasLockableContext({}), false);
      assert.equal(hasLockableContext({ gcloud: { account: null, project: null } }), false);
    });
  });

  describe("suggestContextToml", () => {
    it("emits only the tables it could read, with source annotations", () => {
      const live: LiveContext = {
        git: { email: "dev@example.com" },
        github: { org: "acme", remote: "github.com/acme/widget" },
        vercel: { orgId: "team_123", projectId: "prj_456" },
        gcloud: { account: "dev@example.com", project: "acme-prod" },
        npm: { registry: "https://registry.npmjs.org" },
      };
      const toml = suggestContextToml(live);
      assert.ok(toml.includes("[context.git]"));
      assert.ok(toml.includes('email = "dev@example.com"'));
      assert.ok(toml.includes('team = "team_123"'));
      assert.ok(toml.includes('project = "prj_456"'));
      // gcloud is ambient → carries a verify warning, github is authoritative.
      assert.ok(/gcloud[\s\S]*VERIFY/.test(toml));
      assert.ok(toml.includes("authoritative"));
    });

    it("omits tables with no readable value", () => {
      const toml = suggestContextToml({ git: { email: "x@y.z" } });
      assert.ok(toml.includes("[context.git]"));
      assert.ok(!toml.includes("[context.gcloud]"));
      assert.ok(!toml.includes("[context.vercel]"));
    });

    it("returns empty string when nothing is readable", () => {
      assert.equal(suggestContextToml({}), "");
    });
  });
});

describe("app-service auth realm/tenant lock (#38)", () => {
  it("keycloak realm: ok on match, mismatch on the wrong realm (dev→prod guard)", () => {
    const declared = { keycloak: { realm: "myapp-dev" } };
    assert.equal(compareContext(declared, { keycloak: { realm: "myapp-dev" } })[0]?.status, "ok");
    assert.equal(
      compareContext(declared, { keycloak: { realm: "myapp-prod" } })[0]?.status,
      "mismatch",
    );
  });

  it("auth0 tenant: unknown when the live tenant can't be read", () => {
    const declared = { auth0: { tenant: "myapp.eu.auth0.com" } };
    const f = compareContext(declared, { auth0: { tenant: null } })[0];
    assert.equal(f?.status, "unknown");
    assert.equal(f?.tool, "auth0");
  });

  it("clerk env: mismatch when a prod (live) key is used where test is declared", () => {
    const declared = { clerk: { env: "test" } };
    assert.equal(compareContext(declared, { clerk: { env: "test" } })[0]?.status, "ok");
    assert.equal(compareContext(declared, { clerk: { env: "live" } })[0]?.status, "mismatch");
  });

  it("undeclared auth services are not checked", () => {
    assert.equal(compareContext({}, { keycloak: { realm: "anything" } }).length, 0);
  });
});

describe("clerkEnvFromKey", () => {
  it("extracts live/test from a publishable key; null otherwise", () => {
    assert.equal(clerkEnvFromKey("pk_live_abc123"), "live");
    assert.equal(clerkEnvFromKey("pk_test_abc123"), "test");
    assert.equal(clerkEnvFromKey("sk_live_nope"), null);
    assert.equal(clerkEnvFromKey(null), null);
    assert.equal(clerkEnvFromKey(""), null);
  });
});

describe("applyContext read-only mode", () => {
  it("applies nothing (no steps) when KIT_READ_ONLY=1", async () => {
    // A context that plans a git step — proves the refusal short-circuits
    // before any step runs (empty result), not just that there's nothing to do.
    const ctx = { git: { email: "dev@example.com" } };
    assert.ok(planContext(ctx).length > 0); // sanity: there is work to refuse
    process.env.KIT_READ_ONLY = "1";
    try {
      const results = await applyContext(ctx, process.cwd());
      assert.deepEqual(results, []);
    } finally {
      delete process.env.KIT_READ_ONLY;
    }
  });
});

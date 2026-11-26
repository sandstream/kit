import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { kitConfig, SecretKeyConfig } from "./config.js";
import { buildInventory, rotationHint } from "./secrets-inventory.js";
import {
  runSecretsIncident,
  runSecretsList,
  type CliIdentityCheck,
  type IncidentDeps,
} from "./secrets-incident-cli.js";
import { snapshotPath } from "./secrets-incident.js";
import { patchGitignore } from "./check-gitignore.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

// Fake vault values. Each must never appear in any output, state file or audit row.
const OLD_A = "fakeold-alpha-7f3e9c";
const OLD_B = "fakeold-bravo-1d2c8a";
const NEW_A = "fakenew-alpha-55aa01";
const INLINE = "fakeinline-value-0b9e";
const ALL_FAKES = [OLD_A, OLD_B, NEW_A, INLINE];

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

function configFor(keys: Record<string, SecretKeyConfig>): kitConfig {
  return { secrets: { store: "1password", keys } };
}

const CONFIG = configFor({
  STRIPE_SECRET_KEY: { source: "1password", ref: "op://Dev/payments/credential" },
  ALPHA_TOKEN: { source: "1password", ref: "op://Dev/alpha/credential" },
  OTHER_TOKEN: { source: "infisical" },
  INLINE_SETTING: { source: "config", value: INLINE },
});

interface Harness {
  deps: IncidentDeps;
  vault: Map<string, string>;
  lines: string[];
}

function tempProject(gitignore = ".kit/*\n.kit-audit.jsonl\n"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-incident-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (gitignore) writeFileSync(join(dir, ".gitignore"), gitignore);
  return dir;
}

function harness(cwd: string, check?: CliIdentityCheck): Harness {
  const vault = new Map<string, string>([
    ["STRIPE_SECRET_KEY", OLD_A],
    ["ALPHA_TOKEN", OLD_B],
  ]);
  const lines: string[] = [];
  const deps: IncidentDeps = {
    cwd,
    read: async (name) => vault.get(name) ?? null,
    resolveCli: async () => ({
      tool: "fakevault",
      path: "/opt/fake/bin/fakevault",
      label: "/opt/fake/bin/fakevault",
    }),
    checkCliIdentity: check ?? (async () => ({ state: "unpinned", detail: "test" })),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  };
  return { deps, vault, lines };
}

function assertNoValues(cwd: string, lines: string[]): void {
  const blobs = [lines.join("\n")];
  for (const f of [snapshotPath(cwd, "1password"), join(cwd, ".kit-audit.jsonl")]) {
    if (existsSync(f)) blobs.push(readFileSync(f, "utf8"));
  }
  for (const blob of blobs) for (const v of ALL_FAKES) assert.ok(!blob.includes(v), `leaked ${v}`);
}

function auditRows(cwd: string): Array<{ success: boolean; metadata: Record<string, unknown> }> {
  return readFileSync(join(cwd, ".kit-audit.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.operation === "secrets.incident");
}

describe("kit secrets list", () => {
  it("filters by backend and never carries a value", async () => {
    const one = buildInventory(CONFIG, { backend: "1password" });
    assert.deepEqual(
      one.map((e) => e.name),
      ["ALPHA_TOKEN", "STRIPE_SECRET_KEY"],
    );
    assert.equal(buildInventory(CONFIG).length, 4);
    assert.equal(buildInventory(CONFIG, { backend: "vault" }).length, 0);
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsList(["--json"], CONFIG, h.deps), true);
      const parsed = JSON.parse(h.lines.join("\n"));
      assert.equal(parsed.keys.length, 4);
      assert.equal(await runSecretsList(["--backend", "config"], CONFIG, h.deps), true);
      assert.equal(await runSecretsList(["--backend", "nope"], CONFIG, h.deps), false);
      assertNoValues(cwd, h.lines);
    } finally {
      rmTemp(cwd);
    }
  });

  it("names a --from-cli playbook where kit has one, otherwise manual", () => {
    assert.equal(rotationHint("STRIPE_SECRET_KEY").kind, "from-cli");
    assert.equal(rotationHint("SUPABASE_SERVICE_ROLE_KEY").kind, "supabase-mgmt-api");
    assert.equal(rotationHint("ALPHA_TOKEN").kind, "manual");
  });
});

describe("kit secrets incident", () => {
  it("snapshots, then verifies changed / unchanged / unresolvable with the right exit", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      assert.ok(h.lines.some((l) => l.includes("kit secrets rotate STRIPE_SECRET_KEY --from-cli")));
      assert.ok(
        h.lines.some((l) => l.includes("/opt/fake/bin/fakevault")),
        "prints the CLI path",
      );
      const snap = readFileSync(snapshotPath(cwd, "1password"), "utf8");
      assert.match(snap, /"fingerprint": "[0-9a-f]{64}"/);
      if (process.platform !== "win32") {
        const { mode } = await import("node:fs").then((fs) =>
          fs.statSync(snapshotPath(cwd, "1password")),
        );
        assert.equal(mode & 0o777, 0o600);
      }

      // Nothing rotated yet: every key unchanged, exit false.
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
      // One rotated, one now unreadable: still false, and unreadable is never "changed".
      h.vault.set("STRIPE_SECRET_KEY", NEW_A);
      h.vault.delete("ALPHA_TOKEN");
      h.lines.length = 0;
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("ALPHA_TOKEN") && l.includes("not verified")));
      // Both rotated: true.
      h.vault.set("ALPHA_TOKEN", "fakenew-bravo-x");
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), true);

      const rows = auditRows(cwd);
      const verify = rows.filter((r) => r.metadata.action === "verify");
      assert.equal(verify.length, 3);
      assert.deepEqual(verify[1]!.metadata.changed, ["STRIPE_SECRET_KEY"]);
      assert.deepEqual(verify[1]!.metadata.unresolvable, ["ALPHA_TOKEN"]);
      assert.equal(verify[2]!.success, true);
      assertNoValues(cwd, h.lines);
    } finally {
      rmTemp(cwd);
    }
  });

  it("a key unreadable at snapshot time has no baseline and never verifies", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      h.vault.delete("ALPHA_TOKEN");
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      h.vault.set("ALPHA_TOKEN", NEW_A);
      h.vault.set("STRIPE_SECRET_KEY", "fakenew-x");
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("no baseline")));
    } finally {
      rmTemp(cwd);
    }
  });

  it("refuses a missing, corrupt or re-keyed snapshot and never re-snapshots silently", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("no snapshot on file")));
      assert.equal(existsSync(snapshotPath(cwd, "1password")), false, "verify never writes");

      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      const extra = configFor({
        ...CONFIG.secrets!.keys!,
        NEW_KEY: { source: "1password", ref: "op://Dev/new/credential" },
      });
      assert.equal(await runSecretsIncident(["1password", "--verify"], extra, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("added since snapshot: NEW_KEY")));

      const path = snapshotPath(cwd, "1password");
      writeFileSync(path, "{not json");
      const before = readFileSync(path, "utf8");
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), false);
      assert.equal(readFileSync(path, "utf8"), before, "a bad snapshot is not replaced");
      assert.equal(await runSecretsIncident(["1password", "--new-snapshot"], CONFIG, h.deps), true);
      const replaced = auditRows(cwd).filter((r) => r.metadata.replaced === true);
      assert.equal(replaced.length, 1, "--new-snapshot is audited");
      assertNoValues(cwd, h.lines);
    } finally {
      rmTemp(cwd);
    }
  });

  it(
    "refuses a snapshot other users can read",
    {
      skip:
        process.platform === "win32" &&
        "POSIX mode bits; Windows uses the ACL check in secure-perms",
    },
    async () => {
      const cwd = tempProject();
      try {
        const h = harness(cwd);
        assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
        chmodSync(snapshotPath(cwd, "1password"), 0o644);
        assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
        assert.ok(h.lines.some((l) => l.includes("not owner-only")));
      } finally {
        rmTemp(cwd);
      }
    },
  );

  it("refuses to read values when the vendor-CLI pin hook reports a mismatch", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd, async () => ({ state: "pinned-mismatch", detail: "hash changed" }));
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), false);
      assert.equal(existsSync(snapshotPath(cwd, "1password")), false);
    } finally {
      rmTemp(cwd);
    }
  });

  it("refuses to write fingerprints where git would not ignore them", async () => {
    const cwd = tempProject("");
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), false);
      assert.equal(existsSync(snapshotPath(cwd, "1password")), false);
      // kit's own required ignore rules cover the state file.
      await patchGitignore(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      const ignored = spawnSync("git", ["check-ignore", "-q", ".kit/incident/1password.json"], {
        cwd,
      });
      assert.equal(ignored.status, 0);
    } finally {
      rmTemp(cwd);
    }
  });

  it("runs end to end through the CLI with the env backend", async () => {
    const cwd = tempProject();
    try {
      writeFileSync(
        join(cwd, ".kit.toml"),
        '[secrets]\nstore = "env"\n[secrets.keys]\nKIT_TEST_INCIDENT_A = { source = "env" }\n',
      );
      const run = (args: string[], value?: string) =>
        spawnSync(process.execPath, [CLI, "secrets", ...args], {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            KIT_NON_INTERACTIVE: "1",
            KIT_NO_UPDATE_CHECK: "1",
            HOME: cwd,
            USERPROFILE: cwd,
            KIT_TEST_INCIDENT_A: value ?? "",
          },
        });
      const list = run(["list", "--backend", "env", "--json"], OLD_A);
      assert.equal(list.status, 0, list.stderr);
      assert.equal(JSON.parse(list.stdout).keys[0].name, "KIT_TEST_INCIDENT_A");
      assert.equal(run(["incident", "env"], OLD_A).status, 0);
      const same = run(["incident", "env", "--verify"], OLD_A);
      assert.notEqual(same.status, 0);
      const changed = run(["incident", "env", "--verify"], NEW_A);
      assert.equal(changed.status, 0, changed.stdout + changed.stderr);
      const out = [list, same, changed].map((r) => r.stdout + r.stderr).join("\n");
      for (const v of ALL_FAKES) assert.ok(!out.includes(v));
      assert.ok(!readFileSync(snapshotPath(cwd, "env"), "utf8").includes(OLD_A));
    } finally {
      rmTemp(cwd);
    }
  });
});

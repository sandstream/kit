import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { kitConfig, SecretKeyConfig } from "./config.js";
import {
  runSecretsIncident,
  runSecretsList,
  type CliIdentityCheck,
  type IncidentDeps,
} from "./secrets-incident-cli.js";
import { snapshotPath } from "./secrets-incident.js";
import { incidentKeyPath, isInsideTree, resolveIncidentProject } from "./secrets-incident-key.js";
import { patchGitignore } from "./check-gitignore.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

// Fake vault values. Each must never appear in any output, state file or audit row.
const OLD_A = "fakeold-alpha-7f3e9c";
const OLD_B = "fakeold-bravo-1d2c8a";
const NEW_A = "fakenew-alpha-55aa01";
const INLINE = "fakeinline-value-0b9e";
const ALL_FAKES = [OLD_A, OLD_B, NEW_A, INLINE];

const FAKE_CLI = "/opt/fake/bin/fakevault";
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

// Per-user key homes live outside every test project, as ~/.kit/incident-keys does.
const KEY_HOMES = realpathSync(mkdtempSync(join(tmpdir(), "kit-incident-home-")));
let keyHomes = 0;
after(() => rmTemp(KEY_HOMES));

function freshKeyRoot(): string {
  return join(KEY_HOMES, String(++keyHomes), ".kit", "incident-keys");
}

function tempProject(gitignore = ".kit/*\n.kit-audit.jsonl\n"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-incident-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (gitignore) writeFileSync(join(dir, ".gitignore"), gitignore);
  return dir;
}

function harness(cwd: string, check?: CliIdentityCheck, keyRoot = freshKeyRoot()) {
  const vault = new Map<string, string>([
    ["STRIPE_SECRET_KEY", OLD_A],
    ["ALPHA_TOKEN", OLD_B],
  ]);
  const lines: string[] = [];
  const deps: IncidentDeps = {
    cwd,
    keyRoot,
    read: async (name) => vault.get(name) ?? null,
    resolveCli: async () => ({ tool: "fakevault", path: FAKE_CLI, label: FAKE_CLI }),
    checkCliIdentity: check ?? (async () => ({ state: "unpinned", detail: "test" })),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  };
  return { deps, vault, lines };
}

/** Every regular file under `dir`, recursively (skipping .git). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".git") return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? filesUnder(path) : e.isFile() ? [path] : [];
  });
}

function assertNoValues(cwd: string, lines: string[], keyRoot?: string): void {
  const blobs = [lines.join("\n")];
  for (const f of [...filesUnder(cwd), ...(keyRoot ? filesUnder(keyRoot) : [])]) {
    blobs.push(readFileSync(f, "utf8"));
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
  it("prints names only, as text or JSON, and rejects an unknown backend", async () => {
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
});

describe("kit secrets incident: snapshot and verify", () => {
  it("snapshots, then verifies changed / unchanged / unresolvable with the right exit", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      assert.ok(h.lines.some((l) => l.includes("kit secrets rotate STRIPE_SECRET_KEY --from-cli")));
      assert.ok(
        h.lines.some((l) => l.includes(FAKE_CLI)),
        "prints the CLI path",
      );
      const snap = readFileSync(snapshotPath(cwd, "1password"), "utf8");
      assert.match(snap, /"fingerprint": "[0-9a-f]{64}"/);
      if (process.platform !== "win32") {
        assert.equal(statSync(snapshotPath(cwd, "1password")).mode & 0o777, 0o600);
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
});

describe("kit secrets incident: snapshot safeguards", () => {
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
});

describe("kit secrets incident: environment backend", () => {
  it("runs end to end through the CLI with the env backend", async () => {
    const cwd = tempProject();
    try {
      writeFileSync(
        join(cwd, ".kit.toml"),
        '[secrets]\nstore = "env"\n[secrets.keys]\nKIT_TEST_INCIDENT_A = { source = "env" }\n',
      );
      const home = join(KEY_HOMES, "e2e");
      const run = (args: string[], value: string) =>
        spawnSync(process.execPath, [CLI, "secrets", ...args], {
          cwd,
          encoding: "utf8",
          env: { ...process.env, HOME: home, USERPROFILE: home, KIT_TEST_INCIDENT_A: value },
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

/** The user key file a test project's snapshot uses. */
async function keyFile(cwd: string, keyRoot: string): Promise<string> {
  const project = await resolveIncidentProject(cwd);
  return incidentKeyPath(keyRoot, project.id, "1password");
}

describe("kit secrets incident: the HMAC key stays outside the repo", () => {
  it("keeps no key in the repo tree: the snapshot holds only a key id", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      const path = await keyFile(cwd, h.deps.keyRoot);
      assert.ok(existsSync(path), "key written to the per-user root");
      assert.equal(isInsideTree(path, cwd), false, "key file is outside the repo");
      const keyHex = readFileSync(path, "utf8").trim();
      const key = Buffer.from(keyHex, "hex");
      const snap = JSON.parse(readFileSync(snapshotPath(cwd, "1password"), "utf8"));
      assert.equal(snap.hmacKey, undefined);
      assert.match(snap.keyId, /^ik_[0-9a-f]{32}$/);
      for (const f of filesUnder(cwd)) {
        const text = readFileSync(f, "utf8");
        for (const enc of ["hex", "base64"] as const) {
          assert.ok(!text.includes(key.toString(enc)), `key material in ${f}`);
        }
      }
      assertNoValues(cwd, h.lines, h.deps.keyRoot);
    } finally {
      rmTemp(cwd);
    }
  });

  it("refuses a key root inside the repo and writes nothing", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd, undefined, join(cwd, ".kit", "incident-keys"));
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("inside the project")));
      assert.equal(existsSync(snapshotPath(cwd, "1password")), false);
      assert.equal(existsSync(join(cwd, ".kit", "incident-keys")), false);
    } finally {
      rmTemp(cwd);
    }
  });

  it("a snapshot file alone, without the user's key, cannot verify", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      // Another user, machine or restored backup: the snapshot is here, the key is not.
      const other = harness(cwd);
      other.vault.set("STRIPE_SECRET_KEY", NEW_A);
      other.vault.set("ALPHA_TOKEN", "fakenew-bravo-x");
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, other.deps), false);
      assert.ok(other.lines.some((l) => l.includes("incident key missing")));
      assert.ok(!other.lines.some((l) => l.includes("changed")), "nothing was compared");
      assert.equal(existsSync(await keyFile(cwd, other.deps.keyRoot)), false, "never re-keys");
      const refused = auditRows(cwd).filter((r) => r.metadata.action === "verify");
      assert.equal(refused.at(-1)!.success, false);
    } finally {
      rmTemp(cwd);
    }
  });
});

describe("kit secrets incident: a missing, unsafe or mismatched key is refused", () => {
  it("refuses a missing key on --verify and on a plain run, and never re-keys", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      const path = await keyFile(cwd, h.deps.keyRoot);
      rmSync(path);
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("incident key missing")));
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), false);
      assert.equal(existsSync(path), false, "a plain run does not create a replacement key");
      // A stale key with no snapshot is not silently replaced either.
      rmSync(snapshotPath(cwd, "1password"));
      writeFileSync(path, `${"ab".repeat(32)}\n`, { mode: 0o600 });
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("already exists")));
      assert.equal(readFileSync(path, "utf8").trim(), "ab".repeat(32));
    } finally {
      rmTemp(cwd);
    }
  });

  it(
    "refuses a key file other users can read",
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
        const path = await keyFile(cwd, h.deps.keyRoot);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(statSync(h.deps.keyRoot).mode & 0o777, 0o700);
        chmodSync(path, 0o640);
        assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
        assert.ok(h.lines.some((l) => l.includes("not owner-only")));
      } finally {
        rmTemp(cwd);
      }
    },
  );
});

describe("kit secrets incident: a re-keyed or old-format snapshot", () => {
  it("refuses a key whose id differs from the snapshot's; --new-snapshot re-keys, audited", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      const path = await keyFile(cwd, h.deps.keyRoot);
      const first = JSON.parse(readFileSync(snapshotPath(cwd, "1password"), "utf8")).keyId;
      writeFileSync(path, `${"cd".repeat(32)}\n`);
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("does not match the snapshot's")));

      assert.equal(await runSecretsIncident(["1password", "--new-snapshot"], CONFIG, h.deps), true);
      const second = JSON.parse(readFileSync(snapshotPath(cwd, "1password"), "utf8")).keyId;
      assert.notEqual(second, first);
      const rekey = auditRows(cwd).filter((r) => r.metadata.replaced === true);
      assert.equal(rekey.length, 1, "--new-snapshot writes one audit row");
      assert.equal(rekey[0]!.success, true);
      assert.equal(rekey[0]!.metadata.hmac_id, second);
      // The new pair verifies again (values unchanged, so false, but compared, not refused).
      h.lines.length = 0;
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("unchanged")));
      assertNoValues(cwd, h.lines, h.deps.keyRoot);
    } finally {
      rmTemp(cwd);
    }
  });

  it("refuses a v1 snapshot that carries its key inline", async () => {
    const cwd = tempProject();
    try {
      const h = harness(cwd);
      assert.equal(await runSecretsIncident(["1password"], CONFIG, h.deps), true);
      const path = snapshotPath(cwd, "1password");
      const snap = JSON.parse(readFileSync(path, "utf8"));
      delete snap.keyId;
      writeFileSync(path, JSON.stringify({ ...snap, version: 1, hmacKey: "AAAA" }));
      assert.equal(await runSecretsIncident(["1password", "--verify"], CONFIG, h.deps), false);
      assert.ok(h.lines.some((l) => l.includes("format v1")));
    } finally {
      rmTemp(cwd);
    }
  });
});

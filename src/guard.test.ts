import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GUARD_TOOLS,
  generateShim,
  reentryVar,
  writeShim,
  staleShims,
  refreshShims,
  rcBlock,
  upsertRcBlock,
  stripRcBlock,
  appendObservation,
  readObservations,
  SHIM_MARKER,
  RC_BEGIN,
  RC_END,
} from "./guard.js";

// kit guard v1 (observe): the shim's contract is FAIL-OPEN by construction —
// it may observe, it must never block or break the real tool. These tests pin
// that contract in the generated text and the file-handling rules.

describe("generateShim", () => {
  const shim = generateShim("npm", "/home/u/.kit/shims");

  it("carries the marker, the bypass knob, and the observe call — in that order of defense", () => {
    assert.ok(shim.includes(SHIM_MARKER));
    assert.ok(shim.includes("KIT_GUARD_BYPASS"));
    assert.ok(shim.includes("kit guard-observe npm"));
  });

  it("observation is silenced AND || true — a kit crash cannot break npm", () => {
    assert.ok(shim.includes('guard-observe npm "$@" >/dev/null 2>&1 || true'));
  });

  it("execs the real binary from PATH, skipping the shims dir; missing binary exits 127", () => {
    assert.ok(shim.includes('[ "${_d%/}" = "${_kit_shims%/}" ] && continue'));
    assert.ok(shim.includes('exec "${_d}/npm" "$@"'));
    assert.ok(shim.includes("exit 127"));
  });

  it("marks a shim-to-shim hand-off per tool, so a nested pip is still observed", () => {
    assert.equal(reentryVar("npm"), "KIT_GUARD_ACTIVE_NPM");
    assert.equal(reentryVar("pip3"), "KIT_GUARD_ACTIVE_PIP3");
    assert.ok(shim.includes("export KIT_GUARD_ACTIVE_NPM=1"));
    assert.ok(
      shim.includes("unset KIT_GUARD_ACTIVE_NPM"),
      "a real-binary exec must not leak the marker",
    );
    assert.ok(generateShim("pip3", "/x").includes("KIT_GUARD_ACTIVE_PIP3"));
  });

  it("only observes when kit is actually on PATH (fresh machine ⇒ pure pass-through)", () => {
    assert.ok(shim.includes("command -v kit >/dev/null"));
  });
});

describe("shim + rc file handling", () => {
  it("writeShim refuses to clobber a file the user authored", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-guard-"));
    try {
      writeFileSync(join(dir, "npm"), "#!/bin/sh\necho my own wrapper\n");
      assert.equal(writeShim("npm", dir), "kept-foreign");
      assert.ok(readFileSync(join(dir, "npm"), "utf-8").includes("my own wrapper"));
      assert.equal(writeShim("brew", dir), "written");
      assert.ok(readFileSync(join(dir, "brew"), "utf-8").includes(SHIM_MARKER));
      // kit-managed files ARE overwritable (idempotent re-install)
      assert.equal(writeShim("brew", dir), "written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeShim replaces by rename, so a shim being executed keeps its old bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-guard-atomic-"));
    try {
      const path = join(dir, "npm");
      writeFileSync(path, `#!/bin/sh\n${SHIM_MARKER}\necho old\n`, { mode: 0o755 });
      // What `sh` holds while it executes the script: an open descriptor it reads from.
      const fd = openSync(path, "r");
      try {
        assert.equal(writeShim("npm", dir), "written");
        const held = Buffer.alloc(64);
        readSync(fd, held, 0, 64, 0);
        assert.match(
          held.toString("utf-8"),
          /echo old/,
          "in-place truncation would splice a running sh",
        );
      } finally {
        closeSync(fd);
      }
      assert.ok(
        readFileSync(path, "utf-8").includes("kit guard-observe npm"),
        "new bytes are in place",
      );
      assert.deepEqual(
        readdirSync(dir).filter((f) => f.includes("kit-tmp")),
        [],
        "no temp file left behind",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("staleShims flags kit shims from an older version and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-guard-stale-"));
    try {
      writeFileSync(join(dir, "npm"), `#!/bin/sh\n${SHIM_MARKER}\nexec npm "$@"\n`, {
        mode: 0o755,
      });
      writeFileSync(join(dir, "pip"), "#!/bin/sh\necho my own wrapper\n", { mode: 0o755 });
      writeShim("brew", dir);
      assert.deepEqual(
        staleShims(dir),
        ["npm"],
        "foreign, current, and absent shims are not stale",
      );
      assert.deepEqual(refreshShims(["npm"], dir), ["npm"]);
      assert.deepEqual(staleShims(dir), [], "refreshed shim matches this version");
      assert.ok(
        readFileSync(join(dir, "pip"), "utf-8").includes("my own wrapper"),
        "foreign file untouched",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upsertRcBlock appends once and replaces in place on re-run", () => {
    const block = rcBlock("/x/shims");
    const first = upsertRcBlock("# my rc\n", block);
    assert.ok(first.includes(RC_BEGIN) && first.includes(RC_END));
    const second = upsertRcBlock(first, rcBlock("/y/shims"));
    assert.equal(second.match(/BEGIN kit guard/g)?.length, 1, "no duplicate blocks");
    assert.ok(second.includes("/y/shims") && !second.includes("/x/shims"));
    assert.ok(second.startsWith("# my rc"), "content outside the markers untouched");
  });

  it("stripRcBlock removes the block and leaves the rest byte-stable", () => {
    const content = upsertRcBlock("# mine\nalias ll='ls -l'\n", rcBlock("/x"));
    const stripped = stripRcBlock(content);
    assert.ok(!stripped.includes("kit guard"));
    assert.ok(stripped.includes("alias ll='ls -l'"));
    assert.equal(stripRcBlock(stripped), stripped, "idempotent on clean content");
  });
});

describe("observation log", () => {
  it("appends and reads back; corrupt rows are skipped, never thrown", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-guard-log-"));
    const saved = process.env.KIT_GUARD_LOG;
    process.env.KIT_GUARD_LOG = join(dir, "obs.jsonl");
    try {
      appendObservation({
        ts: "2026-07-30T00:00:00Z",
        cwd: "/p",
        tool: "npx",
        command: "npx evil",
        wouldBlock: true,
        reason: "triage did not pass",
        refs: ["npm:evil"],
      });
      writeFileSync(
        join(dir, "obs.jsonl"),
        readFileSync(join(dir, "obs.jsonl"), "utf-8") + "{corrupt\n",
      );
      const obs = readObservations();
      assert.equal(obs.length, 1);
      assert.equal(obs[0].wouldBlock, true);
      assert.deepEqual(obs[0].refs, ["npm:evil"]);
    } finally {
      if (saved === undefined) delete process.env.KIT_GUARD_LOG;
      else process.env.KIT_GUARD_LOG = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing log reads as empty (fresh machine)", () => {
    const saved = process.env.KIT_GUARD_LOG;
    process.env.KIT_GUARD_LOG = join(tmpdir(), "kit-guard-nope", "missing.jsonl");
    try {
      assert.deepEqual(readObservations(), []);
    } finally {
      if (saved === undefined) delete process.env.KIT_GUARD_LOG;
      else process.env.KIT_GUARD_LOG = saved;
    }
  });
});

// #461: the shim hands off to the next `npm` on PATH. When that next entry belongs
// to ANOTHER shim manager (mise/asdf/pyenv/rbenv), that manager re-resolves `npm`
// through PATH — with kit's shims still first — and the two shims ping-pong
// forever: no output, no real npm, ~20% CPU per stuck process, hours of elapsed
// time. These tests run the generated sh for real, so a regression is a killed
// child with empty stdout rather than a quiet pass.
type CompetingShim = "none" | "peer" | "owns-tool";

interface ShimRun {
  stdout: string;
  stderr: string;
  status: number | null;
  /** Non-null means the child had to be killed — i.e. it never finished. */
  signal: string | null;
}

function runShim(
  competing: CompetingShim,
  opts: { duplicateKitOnPath?: boolean; bypass?: boolean; noRealNpm?: boolean } = {},
): ShimRun {
  const root = mkdtempSync(join(tmpdir(), "kit-guard-handoff-"));
  try {
    const kitShims = join(root, "kit", "shims");
    const otherShims = join(root, "other", "shims"); // a */shims dir, like mise/asdf/pyenv
    const installBin = join(root, "installs", "node", "bin"); // where a version manager keeps the real tool
    const sysBin = join(root, "usr", "bin");
    for (const d of [kitShims, otherShims, installBin, sysBin]) mkdirSync(d, { recursive: true });

    writeFileSync(join(kitShims, "npm"), generateShim("npm", kitShims), { mode: 0o755 });

    // The stand-in for the real npm reports what it inherited, so a test can assert
    // on the hand-off's side effects (marker leakage, PATH surgery), not merely that
    // something ran.
    const reporter = (tag: string) =>
      `#!/bin/sh\necho "${tag} npm $*"\necho "MARKER=\${KIT_GUARD_ACTIVE_NPM:-unset}"\necho "PATH=\$PATH"\n`;
    if (!opts.noRealNpm) {
      const realDir = competing === "owns-tool" ? installBin : sysBin;
      writeFileSync(join(realDir, "npm"), reporter("REAL"), { mode: 0o755 });
      // With a version manager in charge, an npm further down PATH is the WRONG
      // one — resolving past the manager's shim would silently pick this.
      if (competing === "owns-tool")
        writeFileSync(join(sysBin, "npm"), reporter("DECOY"), { mode: 0o755 });
    }
    if (competing === "peer") {
      // The measured #461 partner: re-resolves the tool through PATH, skipping only
      // ITS own dir — exactly kit's own rule. Two shims with that rule ping-pong.
      writeFileSync(
        join(otherShims, "npm"),
        `#!/bin/sh
_oi="\${IFS}"
IFS=:
for _d in \$PATH; do
  IFS="\${_oi}"
  [ -n "\${_d}" ] || continue
  [ "\${_d}" = "${otherShims}" ] && continue
  [ -x "\${_d}/npm" ] && exec "\${_d}/npm" "$@"
done
echo "peer-shim: npm not found" >&2
exit 127
`,
        { mode: 0o755 },
      );
    } else if (competing === "owns-tool") {
      // A manager that resolves internally to the version it selected.
      writeFileSync(join(otherShims, "npm"), `#!/bin/sh\nexec "${installBin}/npm" "$@"\n`, {
        mode: 0o755,
      });
    }

    const path = [kitShims];
    if (opts.duplicateKitOnPath) path.push(`${kitShims}/`); // rc sourced twice / trailing slash
    if (competing !== "none") path.push(otherShims);
    path.push(sysBin);

    // No `kit` on this PATH ⇒ observation is skipped, so the test measures the
    // hand-off alone.
    const r = spawnSync(join(kitShims, "npm"), ["--version"], {
      env: { PATH: path.join(":"), HOME: root, ...(opts.bypass ? { KIT_GUARD_BYPASS: "1" } : {}) },
      encoding: "utf-8",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status,
      signal: r.signal ?? null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const pathSeenBy = (run: ShimRun): string =>
  run.stdout.split("\n").find((l) => l.startsWith("PATH=")) ?? "";

describe("hand-off when another shim manager owns the tool (#461)", () => {
  it("a competing shim that re-resolves via PATH cannot ping-pong the shim", () => {
    const r = runShim("peer");
    assert.equal(r.signal, null, "the shim never returned — the #461 ping-pong is back");
    assert.match(r.stdout, /REAL npm --version/);
    assert.ok(
      !pathSeenBy(r).includes("/kit/shims"),
      "after a shim-to-shim hand-off kit's dir must be off PATH — that is what makes re-entry impossible",
    );
  });

  it("hands off THROUGH the version manager, never past it to the wrong npm", () => {
    const r = runShim("owns-tool");
    assert.equal(r.signal, null);
    assert.match(r.stdout, /REAL npm --version/);
    assert.doesNotMatch(
      r.stdout,
      /DECOY/,
      "skipping the manager's shim would run an npm it did not select",
    );
  });

  it("kit's dir listed twice (rc sourced twice, trailing slash) still terminates", () => {
    const r = runShim("peer", { duplicateKitOnPath: true });
    assert.equal(r.signal, null, "the shim never returned — the #461 ping-pong is back");
    assert.match(r.stdout, /REAL npm --version/);
    assert.ok(
      !pathSeenBy(r).includes("/kit/shims"),
      "every occurrence must be dropped, not the first",
    );
  });

  it("KIT_GUARD_BYPASS=1 reaches the real tool too — the bypass never fixed the loop", () => {
    const r = runShim("peer", { bypass: true });
    assert.equal(r.signal, null, "bypass must not hang either");
    assert.match(r.stdout, /REAL npm --version/);
  });

  it("no competing shim ⇒ PATH and marker untouched, so nested installs stay observed", () => {
    const r = runShim("none");
    assert.equal(r.signal, null);
    assert.match(r.stdout, /REAL npm --version/);
    assert.match(r.stdout, /MARKER=unset/, "no hand-off happened ⇒ no re-entry marker to leak");
    assert.ok(
      pathSeenBy(r).includes("/kit/shims"),
      "the guard must still cover what the real tool spawns",
    );
  });

  it("nothing to hand off to still exits 127 with the uninstall hint", () => {
    const r = runShim("none", { noRealNpm: true });
    assert.equal(r.signal, null);
    assert.equal(r.status, 127);
    assert.match(r.stderr, /kit guard uninstall/);
  });
});

describe("coverage roster", () => {
  it("the fetch-and-run family is on the roster — npx-shaped tools above all", () => {
    for (const t of ["npx", "bunx", "pipx", "uvx", "npm", "bun", "brew", "pip"]) {
      assert.ok(GUARD_TOOLS.includes(t), `${t} missing from GUARD_TOOLS`);
    }
    assert.ok(!existsSync("/nonexistent"), "sanity");
  });
});

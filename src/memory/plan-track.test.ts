import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMemoryDb } from "./db.js";
import { palList, palShow, palSnooze } from "./pal.js";
import { scanPlanFiles, syncPlanFiles } from "./plan-track.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const parent = mkdtempSync(join(tmpdir(), "kit-plan-track-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "project-public");
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "https://example.test/team/project.git",
  ]);
  const db = openMemoryDb(":memory:");
  t.after(() => db.close());
  return { parent, root, db };
}

it("finds repository and matching adjacent plans without reading other projects", (t) => {
  const { parent, root } = fixture(t);
  writeFileSync(join(parent, "project-roadmap-plan-2026.md"), "# Roadmap\nStatus: PROPOSAL\n");
  writeFileSync(join(parent, "other-roadmap-plan-2026.md"), "Status: PROPOSAL\n");
  writeFileSync(join(root, "docs", "plans", "deployment-plan.md"), "Status: DONE\n");
  const report = scanPlanFiles(root);
  assert.equal(report.issues.length, 0);
  assert.deepEqual(
    report.plans.map((p) => [p.name, p.state]),
    [
      ["deployment-plan.md", "complete"],
      ["project-roadmap-plan-2026.md", "open"],
    ],
  );
});

it("keeps unknown plans visible and refuses completion when a checkbox remains open", (t) => {
  const { parent, root } = fixture(t);
  writeFileSync(join(parent, "project-old-plan.md"), "# Old plan\nNo status line.\n");
  writeFileSync(join(root, "plan.md"), "Status: DONE\n- [ ] Finish migration\n");
  const report = scanPlanFiles(root);
  assert.deepEqual(
    report.plans.map((p) => [p.name, p.state]),
    [
      ["project-old-plan.md", "unknown"],
      ["plan.md", "open"],
    ],
  );
});

it("treats a pending progress row as open despite a completed status line", (t) => {
  const { root } = fixture(t);
  writeFileSync(
    join(root, "plan.md"),
    "Status: DONE\n\n| Phase | Status |\n| --- | --- |\n| P1 | Built |\n| P2 | Pending decision |\n",
  );
  assert.equal(scanPlanFiles(root).plans[0]?.state, "open");
});

it("does not accept a qualified completion claim", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "plan.md"), "Status: DONE except the final release\n");
  assert.equal(scanPlanFiles(root).plans[0]?.state, "open");
});

it("tracks open plans, closes explicit completion, and retains missing sources", (t) => {
  const { parent, root, db } = fixture(t);
  const completed = join(parent, "project-first-plan.md");
  const missing = join(parent, "project-second-plan.md");
  writeFileSync(completed, "Status: PROPOSAL\n");
  writeFileSync(missing, "Status: PROPOSAL\n");
  const first = syncPlanFiles(db, root);
  assert.equal(first.added, 2);
  const stable = palList(db, { scope: root })[0]!;
  const frontier = palShow(db, stable.id)?.frontier;
  assert.equal(syncPlanFiles(db, root).added, 0);
  assert.equal(palShow(db, stable.id)?.frontier, frontier);
  writeFileSync(completed, "Status: DONE\n");
  unlinkSync(missing);
  const second = syncPlanFiles(db, root);
  assert.equal(second.closed.length, 1);
  const open = palList(db, { scope: root });
  assert.equal(open.length, 1);
  assert.match(open[0]!.title, /second-plan/);
  assert.match(open[0]!.detail ?? "", /source missing/);
});

it("closes a snoozed plan when its source reports completion", (t) => {
  const { parent, root, db } = fixture(t);
  const plan = join(parent, "project-snoozed-plan.md");
  writeFileSync(plan, "Status: PROPOSAL\n");
  syncPlanFiles(db, root);
  const [item] = palList(db, { scope: root });
  assert.ok(item);
  assert.equal(palSnooze(db, item.id, 7), true);
  writeFileSync(plan, "Status: DONE\n");
  assert.equal(syncPlanFiles(db, root).closed.length, 1);
  assert.equal(palList(db, { scope: root, status: "snoozed" }).length, 0);
});

it("does not follow symlinks or clear old items when a source cannot be scanned", (t) => {
  const { parent, root, db } = fixture(t);
  const plan = join(parent, "project-plan.md");
  writeFileSync(plan, "Status: PROPOSAL\n");
  syncPlanFiles(db, root);
  unlinkSync(plan);
  symlinkSync(join(parent, "untrusted.md"), plan);
  const result = syncPlanFiles(db, root);
  assert.equal(result.closed.length, 0);
  assert.equal(palList(db, { scope: root }).length, 1);
  assert.match(result.issues.join(" "), /symlink/);
});

it("real PAL list and session start show pending plans, then close completed plans", (t) => {
  const { parent, root } = fixture(t);
  const plan = join(parent, "project-release-plan.md");
  writeFileSync(plan, "Status: PROPOSAL\n");
  const source = import.meta.url.endsWith(".ts");
  const cli = fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url));
  const memory = join(parent, "memory.db");
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const result = spawnSync(
      process.execPath,
      [...(source ? ["--import", import.meta.resolve("tsx")] : []), cli, "memory", ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          KIT_MEMORY_DB: memory,
          KIT_DEVICE_ID: "plan-test-device",
          KIT_NO_UPDATE_CHECK: "1",
          KIT_NO_HINTS: "1",
          KIT_AUDIT_ANCHOR: "0",
          KIT_NON_INTERACTIVE: "1",
          ...extra,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const first = JSON.parse(run(["pal", "list", "--json"])) as { title: string }[];
  assert.equal(first.length, 1);
  assert.match(first[0]!.title, /project-release-plan/);
  assert.match(run(["hook", "session-start"]), /Open plan files: project-release-plan\.md/);
  writeFileSync(plan, "Status: DONE\n");
  assert.deepEqual(JSON.parse(run(["pal", "list", "--json"])), []);
  writeFileSync(join(parent, "project-new-plan.md"), "Status: PROPOSAL\n");
  assert.deepEqual(JSON.parse(run(["pal", "list", "--json"], { KIT_READ_ONLY: "1" })), []);
});

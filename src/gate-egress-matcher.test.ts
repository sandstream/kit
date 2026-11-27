/**
 * The opt-in `kit gate-egress` reads shell commands, PowerShell's `Invoke-WebRequest` among them,
 * but `kit agent-config --broker-gate` installed it with the matcher `Bash`, so a command Claude
 * Code ran through its `PowerShell` tool never reached it. Same reading and repair as gate-bash.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBrokerGates, installEnvWriteGate, installInstallGate } from "./agent-config.js";
import { checkGateLiveness } from "./check-security.js";
import { staleShellGateMatchers, widenGateEgressMatchers } from "./gate-bash-matcher.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

interface Group {
  matcher?: string;
  hooks?: { command: string }[];
}

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-egress-pwsh-"));
  // An empty HOME, so a real ~/.claude/settings.json cannot add user-level gates.
  const prevHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmTemp(dir);
  });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

const settingsPath = (dir: string) => join(dir, ".claude", "settings.json");
const preToolUse = (dir: string): Group[] =>
  JSON.parse(readFileSync(settingsPath(dir), "utf-8")).hooks.PreToolUse as Group[];
const holdsEgress = (g: Group) => (g.hooks ?? []).some((h) => h.command.endsWith("gate-egress"));

/** Rewrite the egress group to the matcher kit wrote before PowerShell was covered. */
function downgradeEgress(dir: string): void {
  const s = JSON.parse(readFileSync(settingsPath(dir), "utf-8"));
  for (const g of s.hooks.PreToolUse as Group[]) if (holdsEgress(g)) g.matcher = "Bash";
  writeFileSync(settingsPath(dir), JSON.stringify(s, null, 2));
}

describe("Claude Code gate-egress matcher", () => {
  it("routes the PowerShell tool to gate-egress on a fresh --broker-gate install", async (t) => {
    const dir = project(t);
    await installBrokerGates(dir);
    const groups = preToolUse(dir).filter(holdsEgress);
    assert.deepEqual(
      groups.map((g) => g.matcher),
      ["Bash|PowerShell"],
    );
  });

  it("kit check names an old Bash-only egress matcher; --broker-gate widens it once", async (t) => {
    const dir = project(t);
    await installInstallGate(dir);
    await installEnvWriteGate(dir);
    await installBrokerGates(dir);
    downgradeEgress(dir);
    const before = await checkGateLiveness(dir, {});
    assert.equal(before.status, "fail", before.detail);
    assert.match(
      before.detail,
      /^egress gate \(gate-egress\) matcher "Bash" does not select both .*PowerShell.*Run: kit agent-config --broker-gate$/,
    );

    assert.equal((await installBrokerGates(dir)).action, "updated");
    const groups = preToolUse(dir).filter(holdsEgress);
    assert.deepEqual(
      groups.map((g) => g.matcher),
      ["Bash|PowerShell"],
    );
    assert.equal(groups[0].hooks?.length, 1, "no duplicate gate-egress hook");
    assert.equal((await installBrokerGates(dir)).action, "unchanged");
    assert.equal((await checkGateLiveness(dir, {})).status, "pass");
  });

  it("the egress repair leaves the gate-bash group and its matcher alone", () => {
    const bash = { matcher: "Bash", hooks: [{ type: "command", command: "/x/kit gate-bash" }] };
    const groups = [bash, { matcher: "Bash", hooks: [{ command: "/x/kit gate-egress" }] }];
    assert.deepEqual(staleShellGateMatchers(groups, "gate-egress"), ["Bash"]);
    assert.ok(widenGateEgressMatchers(groups));
    assert.equal(groups[0].matcher, "Bash", "the gate-bash group keeps its own matcher");
    assert.deepEqual(staleShellGateMatchers(groups, "gate-egress"), []);
  });
});

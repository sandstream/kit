/**
 * `kit guard` (human: install/status/uninstall) + `kit guard-observe` (shim
 * protocol — invoked by the ~/.kit/shims wrappers, never typed by a person).
 * See src/guard.ts for the design contract: v1 observes, never blocks.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { c } from "../utils/colors.js";
import {
  GUARD_TOOLS,
  guardShimsDir,
  guardRcFiles,
  guardLogPath,
  generateShim,
  writeShim,
  rcBlock,
  upsertRcBlock,
  stripRcBlock,
  appendObservation,
  readObservations,
  SHIM_MARKER,
} from "../guard.js";

/** Shim protocol: reconstruct the command, ask the SAME gate the agents use what
 *  it would decide, log it, exit 0. Never blocks (v1 = observe), never throws. */
export async function cmdGuardObserve(): Promise<boolean> {
  try {
    const [tool, ...rest] = process.argv.slice(3);
    if (!tool) return true;
    const command = [tool, ...rest].join(" ");
    const { parseInstallCommand, decideBashGate } = await import("../install-gate.js");
    const probe = parseInstallCommand(command);
    if (!probe.isInstall) return true; // non-install invocation — no signal, no noise
    const verdict = await decideBashGate(command);
    appendObservation({
      ts: new Date().toISOString(),
      cwd: process.cwd(),
      tool,
      command: command.slice(0, 200),
      wouldBlock: verdict.block,
      reason: verdict.reason.slice(0, 300),
      refs: probe.refs,
    });
  } catch {
    // observe is best-effort by contract — the shim runs the real tool regardless
  }
  return true;
}

function installGuard(): boolean {
  const dir = guardShimsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kept: string[] = [];
  for (const tool of GUARD_TOOLS) {
    if (writeShim(tool, dir) === "kept-foreign") kept.push(tool);
  }
  console.log(
    `${c.green}✓${c.reset} ${GUARD_TOOLS.length - kept.length} shim(s) written to ${dir} ${c.dim}(observe mode — logs only, never blocks)${c.reset}`,
  );
  for (const t of kept) {
    console.warn(
      `${c.yellow}!${c.reset} ${dir}/${t} exists and is not kit-managed — left untouched`,
    );
  }
  for (const rc of guardRcFiles()) {
    const current = existsSync(rc) ? readFileSync(rc, "utf-8") : "";
    writeFileSync(rc, upsertRcBlock(current, rcBlock(dir)), { mode: 0o600 });
    console.log(`${c.green}✓${c.reset} PATH block in ${rc}`);
  }
  console.log(
    `${c.dim}New shells pick it up automatically; current shell: export PATH="${dir}:$PATH"${c.reset}`,
  );
  console.log(`${c.dim}Observations land in ${guardLogPath()} — see: kit guard status${c.reset}`);
  return true;
}

function uninstallGuard(): boolean {
  const dir = guardShimsDir();
  let removed = 0;
  for (const tool of GUARD_TOOLS) {
    const path = `${dir}/${tool}`;
    try {
      if (existsSync(path) && readFileSync(path, "utf-8").includes(SHIM_MARKER)) {
        rmSync(path);
        removed++;
      }
    } catch {
      // leave anything we cannot verify
    }
  }
  for (const rc of guardRcFiles()) {
    if (!existsSync(rc)) continue;
    const current = readFileSync(rc, "utf-8");
    const stripped = stripRcBlock(current);
    if (stripped !== current) {
      writeFileSync(rc, stripped, { mode: 0o600 });
      console.log(`${c.green}✓${c.reset} PATH block removed from ${rc}`);
    }
  }
  console.log(`${c.green}✓${c.reset} ${removed} kit-managed shim(s) removed`);
  return true;
}

function guardStatus(): boolean {
  const dir = guardShimsDir();
  const shims = GUARD_TOOLS.filter((t) => {
    try {
      return (
        existsSync(`${dir}/${t}`) && readFileSync(`${dir}/${t}`, "utf-8").includes(SHIM_MARKER)
      );
    } catch {
      return false;
    }
  });
  const onPath = (process.env.PATH ?? "").split(":").includes(dir);
  console.log(`${c.bold}kit guard${c.reset} — observe mode (never blocks)`);
  console.log(
    `  shims: ${shims.length}/${GUARD_TOOLS.length} installed  ·  PATH active in this shell: ${onPath ? `${c.green}yes${c.reset}` : `${c.yellow}no${c.reset}`}`,
  );
  const obs = readObservations();
  const wouldBlock = obs.filter((o) => o.wouldBlock);
  console.log(
    `  observations: ${obs.length} install-shaped command(s)  ·  ${wouldBlock.length > 0 ? c.yellow : c.green}${wouldBlock.length} would have been blocked${c.reset}`,
  );
  for (const o of obs.slice(-5)) {
    const icon = o.wouldBlock ? `${c.yellow}!${c.reset}` : `${c.green}✓${c.reset}`;
    console.log(`  ${icon} ${o.ts}  ${o.command}  ${c.dim}${o.reason}${c.reset}`);
  }
  if (shims.length === 0) {
    console.log(`  ${c.dim}install with: kit guard install${c.reset}`);
  }
  return true;
}

export async function cmdGuard(): Promise<boolean> {
  const sub = process.argv[3];
  if (sub === "install") return installGuard();
  if (sub === "uninstall") return uninstallGuard();
  if (sub === "status" || !sub) return guardStatus();
  console.log(`${c.bold}kit guard${c.reset} — install gate for your own terminal (observe mode)`);
  console.log("\nUsage:");
  console.log("  kit guard install     Write package-manager shims + PATH block (observe only)");
  console.log("  kit guard status      Shims, PATH state, and what WOULD have been blocked");
  console.log("  kit guard uninstall   Remove shims + PATH block");
  console.log(`\n${c.dim}Covers: ${GUARD_TOOLS.join(" ")}${c.reset}`);
  console.log(`${c.dim}Bypass one call: KIT_GUARD_BYPASS=1 <tool> …${c.reset}`);
  return sub === "--help" || sub === "-h";
}

// Re-exported for tests (pure text).
export { generateShim };

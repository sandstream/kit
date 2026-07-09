/**
 * Remediation + package maintenance leaves, extracted from cli.ts (5.0-alpha
 * god-module split). `kit heal` (deterministic auto-fix of security findings,
 * fail-closed on possible tampering) and `kit pkg` (triage-gated package
 * install). Independent leaves — each returns a boolean verdict for COMMANDS.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { parsePkgSpec, installPkg } from "../pkg.js";

/** Map a security finding to a short, actionable PAL title/detail. */
export async function cmdHeal(): Promise<boolean> {
  const dryRun = hasFlag(process.argv, "--dry-run");
  const agent = hasFlag(process.argv, "--agent");
  console.log(
    `${c.bold}${c.cyan}kit heal${c.reset}${dryRun ? `${c.dim} (dry-run)${c.reset}` : ""}`,
  );
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const { runHeal } = await import("../heal.js");
  // Progress goes to stderr: live feedback for a human watching, without
  // polluting the machine-readable proposals on stdout (--agent).
  const res = await runHeal({ dryRun, onProgress: (m) => console.error(`${c.dim}${m}${c.reset}`) });
  console.log();

  if (dryRun) {
    if (res.plannedSafe.length > 0) {
      console.log(`${c.bold}Would auto-fix (safe):${c.reset}`);
      for (const k of res.plannedSafe) console.log(`  ${c.green}✓${c.reset} ${k}`);
    } else {
      console.log(`${c.dim}Nothing to auto-fix.${c.reset}`);
    }
  } else if (res.healed.length > 0) {
    console.log(`${c.green}${c.bold}Healed ${res.healed.length}:${c.reset}`);
    for (const k of res.healed) console.log(`  ${c.green}✓${c.reset} ${k}`);
  }

  // FAIL-CLOSED — loud, never auto-healed.
  if (res.failClosed.length > 0) {
    console.log(
      `\n${c.red}${c.bold}⚠ FAIL-CLOSED — not auto-healed (possible tampering):${c.reset}`,
    );
    for (const r of res.failClosed) {
      console.log(`  ${c.red}✗${c.reset} ${r.name}: ${r.detail}`);
      if (r.suggestion) console.log(`    ${c.dim}${r.suggestion}${c.reset}`);
    }
  }

  // GATED — proposed, never auto-run by kit.
  if (res.gated.length > 0) {
    console.log(`\n${c.yellow}${c.bold}Gated — needs you (kit won't auto-run these):${c.reset}`);
    for (const g of res.gated) {
      console.log(`  ${c.yellow}!${c.reset} ${g.name}: ${g.issue}`);
      console.log(`    ${c.dim}→ ${g.action}${c.reset}`);
    }
    if (agent) {
      console.log(
        `\n${c.dim}# agent: each command below still hits the elevation gate + audit log${c.reset}`,
      );
      for (const g of res.gated) console.log(g.action);
    }
  }

  const green = res.failClosed.length === 0 && res.gated.length === 0;
  console.log();
  if (!dryRun) {
    console.log(
      green
        ? `${c.green}${c.bold}All findings healed or clean ✓${c.reset}`
        : `${c.yellow}Auto-heal done; items above need you.${c.reset}`,
    );
  }
  return green;
}

export async function cmdPkg(): Promise<boolean> {
  const args = process.argv.slice(3);
  const input = args[0];

  if (!input || input === "--help" || input === "-h") {
    console.log(`${c.bold}kit pkg${c.reset} — Install packages with mandatory triage\n`);
    console.log("Usage:  kit pkg <ecosystem>:<package>[@version]\n");
    console.log("Ecosystems:");
    console.log("  npm:express            npm install express");
    console.log("  npm-g:vercel           npm install -g vercel");
    console.log("  pnpm:react             pnpm add react");
    console.log("  pip:requests           pip install requests");
    console.log("  brew:trivy             brew install trivy");
    console.log("  docker:postgres        docker pull postgres");
    console.log("  go:golang.org/x/tools/cmd/goimports@latest");
    console.log("  cargo:ripgrep          cargo install ripgrep");
    console.log("");
    console.log("Examples:");
    console.log("  kit pkg npm:express@4.18.0");
    console.log("  kit pkg pip:requests");
    console.log("  kit pkg docker:stalwartlabs/stalwart");
    console.log("  kit pkg brew:semgrep");
    return true;
  }

  const spec = parsePkgSpec(input);
  if (!spec) {
    console.error(`${c.red}Invalid format: ${input}${c.reset}`);
    console.error("Expected: <ecosystem>:<package> (e.g. npm:express, pip:requests)");
    return false;
  }

  console.log(
    `${c.bold}Installing ${spec.ecosystem}:${spec.name}${spec.version ? `@${spec.version}` : ""}${c.reset}\n`,
  );
  console.log(`${c.cyan}Step 1: Triage...${c.reset}`);

  const result = await installPkg(spec);
  console.log(result.output);

  return result.installed;
}

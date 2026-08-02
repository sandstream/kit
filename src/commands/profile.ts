/**
 * `kit profile` — the versioned, traveling project profile surface (Pillar 4 step 3).
 *
 * Design: `kit-research/docs/research/pillar4-traveling-profile-5.0.md`.
 *
 * Three subcommands over the schema (`profile/schema.ts`) + drift core
 * (`profile/reconcile.ts`):
 *   - `show`   — render the declared profile with per-line reconciliation marks.
 *   - `freeze` — snapshot the DISCOVERED toolchain into `.kit-profile.toml`, preserving any
 *                operator-authored sections (name/workflows/plugins/gates/scope). A deliberate
 *                operator action, like `kit baseline freeze`.
 *   - `check`  — report declared-vs-discovered drift; `--gate` turns any drift into a non-zero
 *                exit for CI. Honest `skip` when no profile is declared.
 *
 * Zero-LLM, deterministic. NEVER auto-mutates the toolchain — freeze writes only the profile
 * declaration, and nothing here removes a skill/server/plugin. `--json` on every subcommand.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { discoverAgentToolchain, discoverPlugins } from "../agent-sbom.js";
import {
  loadProfile,
  saveProfile,
  profileFingerprint,
  PROFILE_FILE,
  type KitProfile,
  type ProfileComponent,
} from "../profile/schema.js";
import {
  computeProfileDrift,
  discoverActualState,
  type ProfileDrift,
  type DriftEntry,
} from "../profile/reconcile.js";
import { signProfile, verifyProfileSignature, PROFILE_SIG_FILE } from "../profile/sign.js";
import { exportBundle, importBundle } from "../profile/portable.js";
import { flagValue } from "../utils/flags.js";
import { readFileSync, writeFileSync } from "node:fs";

function noProfileNotice(jsonMode: boolean): boolean {
  if (jsonMode) {
    console.log(JSON.stringify({ skipped: true, reason: "no profile declared" }, null, 2));
    return true;
  }
  console.log(`${c.bold}kit profile${c.reset}`);
  console.log(
    `  ${c.yellow}!${c.reset} ${c.dim}no ${c.reset}${c.bold}${PROFILE_FILE}${c.reset}${c.dim} declared — run ${c.reset}${c.bold}kit profile freeze${c.reset}${c.dim} to snapshot the current setup. Skipped.${c.reset}`,
  );
  return true;
}

function statusMark(status: DriftEntry["status"]): string {
  switch (status) {
    case "in-sync":
      return `${c.green}✓ in sync ${c.reset}`;
    case "version-drift":
      return `${c.yellow}⚠ DRIFT   ${c.reset}`;
    case "removed":
      return `${c.yellow}⚠ REMOVED ${c.reset}`;
    case "added":
      return `${c.yellow}⚠ ADDED   ${c.reset}`;
  }
}

function detailFor(e: DriftEntry): string {
  switch (e.status) {
    case "version-drift":
      return `${c.dim}declared ${e.declared}, found ${e.found}${c.reset}`;
    case "removed":
      return `${c.dim}declared, not present${c.reset}`;
    case "added":
      return `${c.dim}present, not declared${c.reset}`;
    case "in-sync":
      return e.declared ? `${c.dim}${e.declared}${c.reset}` : "";
  }
}

/** Render a drift report (shared by show + check). */
function renderDrift(drift: ProfileDrift): void {
  const byKind = new Map<string, DriftEntry[]>();
  for (const e of drift.entries) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }
  const labels: Record<string, string> = {
    skill: "skills",
    mcp: "mcp servers",
    workflow: "workflows",
    plugin: "plugins",
  };
  for (const kind of ["skill", "mcp", "workflow", "plugin"]) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    console.log(`  ${c.bold}${labels[kind]}${c.reset}`);
    for (const e of list) {
      console.log(`    ${statusMark(e.status)} ${e.name}  ${detailFor(e)}`);
    }
  }
  if (drift.vault) {
    const mark =
      drift.vault.status === "in-sync" ? statusMark("in-sync") : statusMark("version-drift");
    const detail =
      drift.vault.status === "in-sync"
        ? `${c.dim}store=${drift.vault.declared}${c.reset}`
        : `${c.dim}declared ${drift.vault.declared}, found ${drift.vault.found ?? "none"}${c.reset}`;
    console.log(`  ${c.bold}vault${c.reset}`);
    console.log(`    ${mark} store  ${detail}`);
  }
  for (const kind of drift.unaudited) {
    console.log(
      `  ${c.dim}? ${labels[kind]}: declared but not auditable yet (discovery lands later) — not judged.${c.reset}`,
    );
  }
}

async function profileShow(jsonMode: boolean): Promise<boolean> {
  const profile = await loadProfile();
  if (!profile) return noProfileNotice(jsonMode);
  const drift = computeProfileDrift(profile, await discoverActualState());
  if (jsonMode) {
    console.log(JSON.stringify({ skipped: false, profile, drift }, null, 2));
    return true;
  }
  console.log(
    `${c.bold}kit profile${c.reset}${profile.name ? ` — ${profile.name}` : ""}  ${c.dim}${profileFingerprint(profile)}${c.reset}`,
  );
  renderDrift(drift);
  console.log(
    drift.clean
      ? `  ${c.green}→ in sync with declaration${c.reset}`
      : `  ${c.dim}→ ${drift.driftCount} drift(s) vs declared profile (kit changes nothing automatically)${c.reset}`,
  );
  return true;
}

async function profileCheck(jsonMode: boolean, gate: boolean): Promise<boolean> {
  const profile = await loadProfile();
  if (!profile) return noProfileNotice(jsonMode);
  const drift = computeProfileDrift(profile, await discoverActualState());
  if (jsonMode) {
    console.log(JSON.stringify({ skipped: false, gate, ...drift }, null, 2));
    return gate ? drift.clean : true;
  }
  console.log(`${c.bold}kit profile check${c.reset}`);
  renderDrift(drift);
  if (drift.clean) {
    console.log(`  ${c.green}✓ no drift vs declared profile${c.reset}`);
    return true;
  }
  console.log(
    `  ${gate ? c.red : c.yellow}→ ${drift.driftCount} drift(s)${c.reset}${c.dim}${gate ? " (gating)" : " (warn — pass --gate to fail CI on drift)"}${c.reset}`,
  );
  return !gate;
}

/** Build a ProfileComponent list from discovered pieces (name + provenance; unpinned). */
function toComponents(items: { name: string; source?: string }[]): ProfileComponent[] {
  return items
    .map((i) => (i.source ? { name: i.name, source: i.source } : { name: i.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function profileFreeze(jsonMode: boolean): Promise<boolean> {
  const cwd = process.cwd();
  const existing = await loadProfile();
  const { skills, mcpServers } = discoverAgentToolchain(cwd);
  const actual = await discoverActualState(cwd);

  // Snapshot the discoverable dimensions (skills/mcp/plugins/vault); preserve the
  // non-discoverable, operator-authored sections (workflows/gates/scope) verbatim.
  const next: KitProfile = {
    version: existing?.version ?? 1,
    generated: existing?.generated ?? new Date(0).toISOString(),
    skills: toComponents(skills),
    mcp: toComponents(mcpServers),
    plugins: toComponents(discoverPlugins(cwd)),
  };
  if (existing?.name) next.name = existing.name;
  if (existing?.workflows) next.workflows = existing.workflows;
  if (existing?.gates) next.gates = existing.gates;
  if (existing?.scope) next.scope = existing.scope;
  const vaultStore = actual.vaultStore ?? existing?.vault?.store;
  if (vaultStore !== undefined) next.vault = { ...existing?.vault, store: vaultStore };
  else if (existing?.vault) next.vault = existing.vault;
  await saveProfile(next, cwd);

  if (jsonMode) {
    console.log(JSON.stringify({ frozen: true, profile: next }, null, 2));
    return true;
  }
  console.log(`${c.bold}kit profile freeze${c.reset} → ${c.bold}${PROFILE_FILE}${c.reset}`);
  console.log(
    `  ${c.green}✓${c.reset} ${next.skills?.length ?? 0} skill(s), ${next.mcp?.length ?? 0} mcp server(s), ${next.plugins?.length ?? 0} plugin(s)${
      next.vault?.store ? `, vault store=${next.vault.store}` : ""
    }`,
  );
  if (existing?.workflows || existing?.scope || existing?.gates) {
    console.log(
      `  ${c.dim}preserved operator-authored sections (workflows/scope/gates) unchanged${c.reset}`,
    );
  }
  console.log(`  ${c.dim}${profileFingerprint(next)}${c.reset}`);
  return true;
}

async function profileSign(jsonMode: boolean): Promise<boolean> {
  const res = await signProfile();
  if (!res.ok) {
    if (jsonMode) {
      console.log(JSON.stringify({ signed: false, error: res.error }, null, 2));
    } else {
      console.error(`${c.red}✗ ${res.error}${c.reset}`);
    }
    return false;
  }
  if (jsonMode) {
    console.log(
      JSON.stringify({ signed: true, kid: res.kid, fingerprint: res.fingerprint }, null, 2),
    );
    return true;
  }
  const rootedNote = res.rooted ? ` ${c.dim}(hardware-rooted)${c.reset}` : "";
  console.log(
    `${c.green}✓${c.reset} signed ${c.bold}${res.fingerprint}${c.reset} as ${c.bold}${res.kid}${c.reset}${rootedNote} ${c.dim}→ ${PROFILE_SIG_FILE}${c.reset}`,
  );
  console.log(
    `${c.dim}commit ${PROFILE_FILE} + ${PROFILE_SIG_FILE}; verifiers check it offline against .kit-policy.signers${c.reset}`,
  );
  return true;
}

async function profileVerify(jsonMode: boolean): Promise<boolean> {
  const r = await verifyProfileSignature(process.cwd(), { key: flagValue(process.argv, "--key") });
  if (jsonMode) {
    console.log(JSON.stringify(r, null, 2));
    // trust-absence (unverifiable) is not a forge — mirror kit policy verify's fail-open there.
    return r.status === "valid" || r.status === "unverifiable";
  }
  switch (r.status) {
    case "valid":
      console.log(
        `${c.green}✓ profile signature valid${c.reset}  ${c.dim}${r.fingerprint} ${r.detail}${c.reset}`,
      );
      return true;
    case "unverifiable":
      console.warn(`${c.yellow}! ${r.detail}${c.reset}`);
      return true;
    case "unsigned":
      console.error(`${c.red}${r.detail}${c.reset}`);
      return false;
    case "invalid":
      console.error(
        `${c.red}✗ profile signature INVALID${c.reset} ${c.dim}(${r.detail})${c.reset}`,
      );
      return false;
    case "revoked":
      console.error(
        `${c.red}✗ profile signed by a REVOKED key${c.reset} ${c.dim}(${r.detail})${c.reset}`,
      );
      return false;
  }
}

function profileExport(jsonMode: boolean): boolean {
  const res = exportBundle();
  if (!res.ok || !res.bundle) {
    if (jsonMode) console.log(JSON.stringify({ exported: false, error: res.error }, null, 2));
    else console.error(`${c.red}✗ ${res.error}${c.reset}`);
    return false;
  }
  const out = flagValue(process.argv, "--out");
  const text = JSON.stringify(res.bundle, null, 2) + "\n";
  if (out) {
    writeFileSync(out, text, "utf-8");
    if (jsonMode) console.log(JSON.stringify({ exported: true, out }, null, 2));
    else
      console.log(
        `${c.green}✓${c.reset} bundle written ${c.dim}→ ${out}${c.reset}\n${c.dim}carry it to a new host and run 'kit profile import <bundle>'${c.reset}`,
      );
  } else {
    // No --out → emit the bundle to stdout so it can be piped/redirected.
    process.stdout.write(text);
  }
  return true;
}

function profileImport(jsonMode: boolean): boolean {
  const path = process.argv[4];
  if (!path || path.startsWith("-")) {
    console.error(`${c.red}usage: kit profile import <bundle.json> [--json]${c.reset}`);
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(
      `${c.red}✗ cannot read bundle: ${e instanceof Error ? e.message : String(e)}${c.reset}`,
    );
    return false;
  }
  const r = importBundle(parsed, process.cwd());
  if (jsonMode) {
    console.log(JSON.stringify(r, null, 2));
    return r.status === "imported-trusted" || r.status === "imported-unanchored";
  }
  switch (r.status) {
    case "imported-trusted":
      console.log(
        `${c.green}✓ imported & trusted${c.reset} ${c.dim}${r.fingerprint} — ${r.detail}${c.reset}`,
      );
      return true;
    case "imported-unanchored":
      console.warn(
        `${c.yellow}! imported (integrity verified, not yet authoritative)${c.reset} ${c.dim}${r.detail}${c.reset}`,
      );
      return true;
    case "revoked":
      console.error(`${c.red}✗ refused — ${r.detail}${c.reset}`);
      return false;
    case "malformed":
      console.error(`${c.red}✗ ${r.detail}${c.reset}`);
      return false;
    case "invalid":
      console.error(`${c.red}✗ refused — integrity check failed: ${r.detail}${c.reset}`);
      return false;
  }
}

export async function cmdProfile(): Promise<boolean> {
  const sub = process.argv[3] ?? "show";
  const jsonMode = hasFlag(process.argv, "--json");
  if (sub === "show") return await profileShow(jsonMode);
  if (sub === "freeze") return await profileFreeze(jsonMode);
  if (sub === "check") return await profileCheck(jsonMode, hasFlag(process.argv, "--gate"));
  if (sub === "sign") return await profileSign(jsonMode);
  if (sub === "verify") return await profileVerify(jsonMode);
  if (sub === "export") return profileExport(jsonMode);
  if (sub === "import") return profileImport(jsonMode);
  console.error(
    `${c.red}usage: kit profile <show|freeze|check|sign|verify|export|import> [--json] [--gate] [--key <pem>] [--out <path>]${c.reset}`,
  );
  return false;
}

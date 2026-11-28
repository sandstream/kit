/**
 * `kit secrets list` and `kit secrets incident <backend> [--verify] [--new-snapshot]`.
 *
 * A vendor-incident path (kit-research#232): list what kit sources from a backend, print each
 * key's rotation command, fingerprint the current values, and after the person rotates, verify
 * that every value really changed. kit never rotates a remote credential here: minting and
 * revoking stay a person's step, because a batch that changes credentials nobody watched is the
 * failure this command exists to recover from. It is a plain CLI, so it behaves the same from
 * Claude Code, Codex or a terminal.
 *
 * No value is printed, logged, audited or stored. Values exist only in memory, long enough to
 * HMAC them (`src/secrets-incident.ts`). The HMAC key lives per user, outside the repo tree
 * (`src/secrets-incident-key.ts`); the snapshot holds only its id.
 */
import { c } from "./utils/colors.js";
import { flagValue, hasFlag } from "./utils/flags.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { resolve } from "node:path";
import { loadConfig, type kitConfig, type SecretKeyConfig } from "./config.js";
import { appendAuditEventDirect } from "./audit.js";
import { EVIDENCE_LIMIT, evidencePlan, type EvidenceStep } from "./secrets-evidence-plan.js";
import { resetInfisicalCache, resolveViaBackend } from "./secret-backends.js";
import {
  buildInventory,
  isKnownBackend,
  knownBackends,
  lastRotations,
  type InventoryEntry,
} from "./secrets-inventory.js";
import {
  allChanged,
  buildSnapshot,
  compareSnapshot,
  isGitIgnored,
  loadSnapshot,
  INCIDENT_AUDIT_OP,
  snapshotPath,
  writeSnapshot,
  type ReadValue,
  type Snapshot,
  type VerifyRow,
} from "./secrets-incident.js";
import {
  createIncidentKey,
  defaultIncidentKeyRoot,
  incidentKeyId,
  incidentKeyPath,
  readIncidentKey,
  resolveIncidentProject,
} from "./secrets-incident-key.js";

/** A vendor-CLI identity verdict. `unpinned` means no pin check ran (see {@link noCliPinCheck}). */
export interface CliIdentityVerdict {
  state: "pinned-match" | "pinned-mismatch" | "unpinned";
  detail: string;
}

/**
 * HOOK POINT for the vendor-CLI identity pin (kit-research#232, "Innovation"). That check is being
 * built separately and is not on main yet. When it lands, pass its check as
 * `IncidentDeps.checkCliIdentity`; a `pinned-mismatch` verdict then refuses the run.
 */
export type CliIdentityCheck = (tool: string, path: string) => Promise<CliIdentityVerdict>;

export const noCliPinCheck: CliIdentityCheck = async () => ({
  state: "unpinned",
  detail: "no vendor-CLI pin check in this kit build",
});

/** The CLI each backend shells out to, and how `secret-backends.ts` finds it. */
const BACKEND_CLI: Record<string, { tool: string; lookup: "mise-first" | "path" }> = {
  "1password": { tool: "op", lookup: "mise-first" },
  infisical: { tool: "infisical", lookup: "mise-first" },
  bitwarden: { tool: "bw", lookup: "mise-first" },
  doppler: { tool: "doppler", lookup: "mise-first" },
  dotenvx: { tool: "dotenvx", lookup: "mise-first" },
  vault: { tool: "vault", lookup: "mise-first" },
  "aws-sm": { tool: "aws", lookup: "path" },
  "gcp-sm": { tool: "gcloud", lookup: "path" },
  "azure-kv": { tool: "az", lookup: "path" },
  eas: { tool: "eas", lookup: "path" },
};

export interface CliSource {
  tool: string | null;
  /** Absolute path of the binary values are read through, or a description when no CLI is used. */
  path: string | null;
  label: string;
  /** Set when 1Password's status probe (bare `op` on PATH) resolves to a different binary. */
  statusPath?: string | null;
}

async function onPath(tool: string): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = await execFileNoThrow(finder, [tool], { timeout: 5_000 });
  return r.ok ? r.stdout.trim().split(/\r?\n/)[0]?.trim() || null : null;
}

/** Resolve the binary a backend reads through, the same way the backend itself does. */
export async function resolveCliSource(backend: string): Promise<CliSource> {
  if (backend === "env") return { tool: null, path: null, label: "process environment (no CLI)" };
  if (backend === "config") return { tool: null, path: null, label: ".kit.toml value (no CLI)" };
  const spec = BACKEND_CLI[backend];
  if (!spec) return { tool: null, path: null, label: "unknown backend" };
  const path = spec.lookup === "path" ? await onPath(spec.tool) : await resolveToolBin(spec.tool);
  const out: CliSource = { tool: spec.tool, path, label: path ?? `${spec.tool} (not found)` };
  if (backend === "1password") {
    const statusPath = await onPath("op");
    if (statusPath !== path) out.statusPath = statusPath;
  }
  return out;
}

export interface IncidentDeps {
  cwd: string;
  /** Per-user directory holding HMAC keys (`~/.kit/incident-keys`); never inside a project. */
  keyRoot: string;
  read: (name: string, cfg: SecretKeyConfig, config: kitConfig) => Promise<string | null>;
  resolveCli: (backend: string) => Promise<CliSource>;
  checkCliIdentity: CliIdentityCheck;
  out: (line: string) => void;
  err: (line: string) => void;
}

async function readThroughBackend(name: string, cfg: SecretKeyConfig, config: kitConfig) {
  const r = await resolveViaBackend(name, cfg, config.secrets?.infisical);
  // A display placeholder (EAS) is not a value: it cannot prove a change.
  if (!r.resolved || r.managed || !r.value) return null;
  return r.value;
}

export function defaultIncidentDeps(cwd: string = process.cwd()): IncidentDeps {
  return {
    cwd,
    keyRoot: defaultIncidentKeyRoot(),
    read: readThroughBackend,
    resolveCli: resolveCliSource,
    checkCliIdentity: noCliPinCheck,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}

// ─── kit secrets list ─────────────────────────────────────────────────────────

function formatEntry(e: InventoryEntry): string {
  const meta = [
    e.expiresAt ? `expires ${e.expiresAt.slice(0, 10)}` : "",
    e.lastRotated ? `rotated ${e.lastRotated.slice(0, 10)}` : "",
  ].filter(Boolean);
  const tail = meta.length ? `  ${c.dim}${meta.join(" · ")}${c.reset}` : "";
  return `  ${e.name}  ${c.dim}[${e.source}]${c.reset}${tail}`;
}

/** `kit secrets list [--backend <name>] [--json]`. Names and metadata only. */
export async function runSecretsList(
  args: string[],
  config: kitConfig,
  deps: Pick<IncidentDeps, "cwd" | "out" | "err">,
): Promise<boolean> {
  const backend = flagValue(args, "--backend");
  if (backend !== undefined && !isKnownBackend(backend)) {
    deps.err(`Unknown backend "${backend}". Known: ${knownBackends().join(", ")}`);
    return false;
  }
  const entries = buildInventory(config, {
    backend,
    rotations: await lastRotations(deps.cwd),
  });
  if (hasFlag(args, "--json")) {
    deps.out(JSON.stringify({ backend: backend ?? null, keys: entries }, null, 2));
    return true;
  }
  deps.out(
    `${c.bold}${c.cyan}kit secrets list${c.reset}${backend ? `  --backend ${backend}` : ""}`,
  );
  if (entries.length === 0) {
    deps.out(`${c.dim}No keys declared${backend ? ` with source "${backend}"` : ""}.${c.reset}`);
    return true;
  }
  for (const e of entries) deps.out(formatEntry(e));
  deps.out(`\n${c.dim}${entries.length} key(s). Names only; no value was read.${c.reset}`);
  return true;
}

// ─── kit secrets incident ─────────────────────────────────────────────────────

async function readValues(
  entries: InventoryEntry[],
  config: kitConfig,
  deps: IncidentDeps,
): Promise<ReadValue[]> {
  resetInfisicalCache();
  const keys = config.secrets?.keys ?? {};
  const out: ReadValue[] = [];
  for (const e of entries) {
    const cfg = keys[e.name];
    out.push({ name: e.name, value: cfg ? await deps.read(e.name, cfg, config) : null });
  }
  return out;
}

function printPlan(backend: string, entries: InventoryEntry[], deps: IncidentDeps): void {
  deps.out(`${c.bold}${c.cyan}kit secrets incident ${backend}${c.reset}`);
  deps.out(
    `${c.dim}Rotation plan: run each command yourself. kit does not rotate remote${c.reset}`,
  );
  deps.out(
    `${c.dim}credentials in a batch; minting and revoking stay a person's step.${c.reset}\n`,
  );
  for (const e of entries) {
    deps.out(`  ${c.bold}${e.name}${c.reset}  ${c.dim}(${e.rotation.kind})${c.reset}`);
    deps.out(`    ${e.rotation.command}`);
  }
  deps.out("");
}

function printStep(step: EvidenceStep, deps: IncidentDeps): void {
  const tag = step.verified ? "" : ` ${c.yellow}(not verified)${c.reset}`;
  deps.out(`    ${step.service}${tag}`);
  if (step.command) deps.out(`      ${step.command}`);
  for (const caveat of step.caveats) deps.out(`      ${c.dim}${caveat}${c.reset}`);
  if (step.source) deps.out(`      ${c.dim}${step.source}${c.reset}`);
}

/** A full ISO 8601 date or date-time, else a placeholder the person fills in. */
function evidenceSince(args: string[]): string | null {
  const raw = flagValue(args, "--since");
  if (raw === undefined) return "<incident-start-ISO-8601>";
  const iso = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
  return iso.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

/**
 * Per key, the command that fetches the store's own access record, then kit's own record
 * (`src/secrets-evidence-plan.ts`). Printed only: kit runs none of them.
 */
function printEvidencePlan(
  entries: InventoryEntry[],
  config: kitConfig,
  deps: IncidentDeps,
  since: string,
): void {
  deps.out(
    `${c.bold}Evidence plan${c.reset}  ${c.dim}(printed only; kit runs none of these)${c.reset}`,
  );
  deps.out(`${c.dim}Where each store records reads of the key since ${since}.${c.reset}`);
  deps.out(`${c.dim}${EVIDENCE_LIMIT}${c.reset}\n`);
  const keys = config.secrets?.keys ?? {};
  for (const e of entries) {
    const cfg = keys[e.name];
    if (!cfg) continue;
    deps.out(`  ${c.bold}${e.name}${c.reset}`);
    for (const step of evidencePlan(e.name, cfg, since)) printStep(step, deps);
  }
  deps.out("");
}

/** Print where values were read from; refuse on a pin mismatch. */
async function reportCliSource(
  backend: string,
  deps: IncidentDeps,
  snapshotCli?: string | null,
): Promise<{ ok: boolean; cli: CliSource }> {
  const cli = await deps.resolveCli(backend);
  deps.out(`${c.bold}Values read through:${c.reset} ${cli.label}`);
  if (cli.statusPath !== undefined) {
    deps.out(
      `${c.yellow}⚠ op status probe resolves to ${cli.statusPath ?? "(not on PATH)"}, a different binary${c.reset}`,
    );
  }
  if (snapshotCli !== undefined && snapshotCli !== cli.path) {
    deps.out(
      `${c.yellow}⚠ snapshot was read through ${snapshotCli ?? "(no CLI)"}; this run uses ${cli.path ?? "(no CLI)"}${c.reset}`,
    );
  }
  if (!cli.tool || !cli.path) return { ok: true, cli };
  const verdict = await deps.checkCliIdentity(cli.tool, cli.path);
  deps.out(`${c.dim}Vendor-CLI pin: ${verdict.state} (${verdict.detail})${c.reset}`);
  if (verdict.state === "pinned-mismatch") {
    deps.err(`${c.red}✗ ${cli.tool} does not match its pin; refusing to read values.${c.reset}`);
    return { ok: false, cli };
  }
  return { ok: true, cli };
}

async function audit(
  deps: IncidentDeps,
  success: boolean,
  metadata: Record<string, unknown>,
  error?: string,
): Promise<boolean> {
  return appendAuditEventDirect(
    {
      operation: INCIDENT_AUDIT_OP,
      environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
      success,
      ...(error ? { error } : {}),
      metadata,
    },
    { cwd: deps.cwd },
  );
}

function namesBy(rows: VerifyRow[], outcome: VerifyRow["outcome"]): string[] {
  return rows.filter((r) => r.outcome === outcome).map((r) => r.name);
}

const OUTCOME_STYLE: Record<VerifyRow["outcome"], string> = {
  changed: `${c.green}✓ changed${c.reset}`,
  unchanged: `${c.red}✗ unchanged${c.reset}`,
  unresolvable: `${c.red}✗ unresolvable: not verified${c.reset}`,
  "no-baseline": `${c.red}✗ no baseline (unreadable at snapshot): not verified${c.reset}`,
};

type KeyResult = { ok: true; key: Buffer } | { ok: false; reason: string };

/** The per-user key for a snapshot. Every problem is a reason, never a re-key. */
async function snapshotKey(
  backend: string,
  snapshot: Snapshot,
  deps: IncidentDeps,
): Promise<KeyResult> {
  try {
    const project = await resolveIncidentProject(deps.cwd);
    const key = await readIncidentKey(deps.keyRoot, project, backend);
    const id = incidentKeyId(key);
    if (id !== snapshot.keyId) {
      return {
        ok: false,
        reason: `incident key id ${id} does not match the snapshot's ${snapshot.keyId}`,
      };
    }
    return { ok: true, key };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

async function refuseVerify(
  backend: string,
  names: string[],
  reason: string,
  deps: IncidentDeps,
): Promise<false> {
  deps.err(`${c.red}✗ Snapshot refused: ${reason}.${c.reset}`);
  deps.err(
    `${c.dim}Nothing was compared. Take a fresh one only if you know why: kit secrets incident ${backend} --new-snapshot${c.reset}`,
  );
  await audit(deps, false, { backend, names, action: "verify" }, `snapshot refused: ${reason}`);
  return false;
}

async function runVerify(
  backend: string,
  entries: InventoryEntry[],
  config: kitConfig,
  deps: IncidentDeps,
): Promise<boolean> {
  const names = entries.map((e) => e.name);
  const loaded = await loadSnapshot(snapshotPath(deps.cwd, backend), backend, names);
  if (!loaded.ok) return refuseVerify(backend, names, loaded.reason, deps);
  const keyed = await snapshotKey(backend, loaded.snapshot, deps);
  if (!keyed.ok) return refuseVerify(backend, names, keyed.reason, deps);
  const src = await reportCliSource(backend, deps, loaded.snapshot.cli);
  if (!src.ok) return false;
  const rows = compareSnapshot(loaded.snapshot, keyed.key, await readValues(entries, config, deps));
  deps.out(`\n${c.bold}Verify against snapshot of ${loaded.snapshot.createdAt}${c.reset}`);
  for (const r of rows) deps.out(`  ${r.name}  ${OUTCOME_STYLE[r.outcome]}`);
  const ok = allChanged(rows);
  const audited = await audit(deps, ok, {
    backend,
    names,
    action: "verify",
    changed: namesBy(rows, "changed"),
    unchanged: namesBy(rows, "unchanged"),
    unresolvable: namesBy(rows, "unresolvable"),
    no_baseline: namesBy(rows, "no-baseline"),
    cli_moved: loaded.snapshot.cli !== src.cli.path,
  });
  const done = rows.filter((r) => r.outcome === "changed").length;
  deps.out(`\n${ok ? c.green : c.red}${done}/${rows.length} changed${c.reset}`);
  return ok && audited;
}

async function takeSnapshot(
  backend: string,
  entries: InventoryEntry[],
  config: kitConfig,
  deps: IncidentDeps,
  replaced: boolean,
): Promise<boolean> {
  const path = snapshotPath(deps.cwd, backend);
  if (!(await isGitIgnored(deps.cwd, path))) {
    deps.err(
      `${c.red}✗ ${path} is not gitignored; refusing to write fingerprints there.${c.reset}`,
    );
    deps.err(`${c.dim}Add .kit/* to .gitignore (kit fix does this), then re-run.${c.reset}`);
    return false;
  }
  const src = await reportCliSource(backend, deps);
  if (!src.ok) return false;
  const names = entries.map((e) => e.name);
  const keyed = await newSnapshotKey(backend, replaced, deps);
  if (!keyed.ok) {
    deps.err(`${c.red}✗ No snapshot taken: ${keyed.reason}.${c.reset}`);
    await audit(deps, false, { backend, names, action: "snapshot", replaced }, keyed.reason);
    return false;
  }
  const values = await readValues(entries, config, deps);
  const snapshot: Snapshot = buildSnapshot(backend, values, src.cli.path, keyed.key);
  await writeSnapshot(path, snapshot);
  const unreadable = snapshot.keys.filter((k) => k.fingerprint === null).map((k) => k.name);
  deps.out(`\n${c.green}✓ Fingerprint snapshot written:${c.reset} ${path}`);
  deps.out(`${c.dim}HMAC key (per user, outside the repo): ${keyed.path}${c.reset}`);
  if (unreadable.length) {
    deps.out(
      `${c.yellow}⚠ unreadable now, so they can never verify: ${unreadable.join(", ")}${c.reset}`,
    );
  }
  deps.out(`${c.dim}After rotating: kit secrets incident ${backend} --verify${c.reset}`);
  return audit(deps, true, {
    backend,
    names,
    action: "snapshot",
    replaced,
    unreadable,
    // Not "key_id": audit redacts any metadata name containing "key".
    hmac_id: snapshot.keyId,
  });
}

/** Create the snapshot's key. Only `--new-snapshot` (`replaced`) may replace an existing key. */
async function newSnapshotKey(
  backend: string,
  replaced: boolean,
  deps: IncidentDeps,
): Promise<(KeyResult & { ok: false }) | { ok: true; key: Buffer; path: string }> {
  try {
    const project = await resolveIncidentProject(deps.cwd);
    const key = await createIncidentKey(deps.keyRoot, project, backend, replaced);
    return { ok: true, key, path: incidentKeyPath(deps.keyRoot, project.id, backend) };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** No flag: keep a usable snapshot, take the first one, refuse anything in between. */
async function snapshotOnce(
  backend: string,
  entries: InventoryEntry[],
  config: kitConfig,
  deps: IncidentDeps,
): Promise<boolean> {
  const path = snapshotPath(deps.cwd, backend);
  const names = entries.map((e) => e.name);
  const existing = await loadSnapshot(path, backend, names);
  const keyed = existing.ok ? await snapshotKey(backend, existing.snapshot, deps) : null;
  if (keyed && !keyed.ok) {
    deps.err(`${c.red}✗ Existing snapshot cannot be verified: ${keyed.reason}.${c.reset}`);
    deps.err(`${c.dim}It was not replaced. Pass --new-snapshot to replace it (audited).${c.reset}`);
    return false;
  }
  if (existing.ok) {
    deps.out(`${c.dim}Snapshot of ${existing.snapshot.createdAt} kept (${path}).${c.reset}`);
    deps.out(`${c.dim}Verify: --verify. Replace it (audited): --new-snapshot.${c.reset}`);
    return true;
  }
  if (existing.reason !== "no snapshot on file") {
    deps.err(`${c.red}✗ Existing snapshot refused: ${existing.reason}.${c.reset}`);
    deps.err(`${c.dim}It was not replaced. Pass --new-snapshot to replace it (audited).${c.reset}`);
    return false;
  }
  return takeSnapshot(backend, entries, config, deps, false);
}

/** `kit secrets incident <backend> [--verify] [--new-snapshot]`. */
export async function runSecretsIncident(
  args: string[],
  config: kitConfig,
  deps: IncidentDeps,
): Promise<boolean> {
  const backend = args[0];
  if (!backend || backend.startsWith("-") || !isKnownBackend(backend)) {
    deps.err(`Usage: kit secrets incident <backend> [--since <ISO>] [--verify] [--new-snapshot]`);
    deps.err(`Backends: ${knownBackends().join(", ")}`);
    return false;
  }
  const entries = buildInventory(config, { backend });
  if (entries.length === 0) {
    deps.out(`${c.dim}No keys declared with source "${backend}"; nothing to do.${c.reset}`);
    return true;
  }
  const since = evidenceSince(args);
  if (since === null) {
    deps.err(`--since takes an ISO 8601 date or date-time, for example 2026-11-20T00:00:00Z.`);
    return false;
  }
  printPlan(backend, entries, deps);
  printEvidencePlan(entries, config, deps, since);
  if (hasFlag(args, "--verify")) return runVerify(backend, entries, config, deps);
  if (hasFlag(args, "--new-snapshot")) return takeSnapshot(backend, entries, config, deps, true);
  return snapshotOnce(backend, entries, config, deps);
}

/** `kit secrets list` / `kit secrets incident`, routed from `src/commands/secrets.ts`. */
export async function cmdSecretsInventory(sub: "list" | "incident"): Promise<boolean> {
  const deps = defaultIncidentDeps();
  const config = await loadConfig(resolve(deps.cwd, ".kit.toml"));
  const args = process.argv.slice(4);
  return sub === "list"
    ? runSecretsList(args, config, deps)
    : runSecretsIncident(args, config, deps);
}

/**
 * `kit check` rows for the vendor-CLI identity pin (see `vendor-cli-pin.ts`).
 *
 * They sit in the security dimension, category `supply-chain`, not in `tools`: `tools` answers
 * "is the declared version installed" and only runs when `[tools]` is declared, while this answers
 * "is the vault CLI the binary the team accepted", a supply-chain integrity question whose failure
 * must move the security verdict (and `--category security`, which the agent instructions run
 * after every batch of edits).
 *
 * - fail: the hash changed and the reported version did not (the tampering signal); also when the
 *   version cannot be read, since then a new release cannot be told apart from a swap.
 * - warn: the version changed (a new release); the row prints the new hash and the accept command.
 * - warn: the CLI resolves to a different file than the pinned one (PATH shadowing).
 * - fail: win32 npm shim — the `.cmd` shim changed while the program it starts did not (a shim
 *   edited to start something else), or the shim cannot be read (kit cannot run the CLI at all).
 * - warn: unpinned — kit runs whatever the tool is first on PATH; the row prints the pin command.
 * - pass: the pinned file, hash and version.
 * - skip: the project uses no vault/cloud CLI and nothing is pinned, or the CLI is not installed.
 *
 * Only a changed hash costs a `--version` run; an unchanged binary is hashed and never executed.
 */
import type { SecurityCheckResult } from "./check-security.js";
import {
  defaultPinDeps,
  expandPath,
  measureCli,
  platformKey,
  projectVendorClis,
  readAllPins,
  readCliVersion,
  sameShim,
  samePath,
  ShimUnreadable,
  type CliIdentity,
  type Launch,
  type Measured,
  type PinDeps,
} from "./vendor-cli-pin.js";

type Row = SecurityCheckResult;
type VersionOf = (bin: string | Launch) => Promise<string | null>;

function row(tool: string, status: Row["status"], detail: string, extra: Partial<Row> = {}): Row {
  return { category: "supply-chain", name: `vendor CLI: ${tool}`, status, detail, ...extra };
}

const short = (sha: string) => sha.slice(0, 12);
const accept = (tool: string) => `kit tools pin --accept ${tool}`;

function unpinnedRow(tool: string, m: Measured | null, others: string[]): Row {
  if (!m) return row(tool, "skip", `${tool} is not installed here; nothing to pin`);
  const elsewhere = others.length ? ` (pinned for ${others.join(", ")} only)` : "";
  return row(
    tool,
    "warn",
    `unpinned: kit runs whatever ${tool} is first on PATH${elsewhere} — now ${m.realpath}`,
    { severity: "medium", suggestion: `kit tools pin ${tool}` },
  );
}

async function changedHashRow(
  tool: string,
  pin: CliIdentity,
  m: Measured,
  moved: string,
  versionOf: VersionOf,
): Promise<Row> {
  const version = await versionOf(m.launch);
  if (version !== null && version !== pin.version) {
    return row(
      tool,
      "warn",
      `${tool} ${pin.version} → ${version} (new release); new sha256 ${m.sha256}${moved}. kit refuses to run it until accepted`,
      { severity: "medium", suggestion: accept(tool) },
    );
  }
  const said =
    version === null ? "its version is unreadable" : `the version is still ${pin.version}`;
  return row(
    tool,
    "fail",
    `${tool} sha256 changed but ${said} — possible tampering. pinned ${short(pin.sha256)} (${pin.path}); now ${short(m.sha256)} (${m.realpath})${moved}`,
    {
      severity: "high",
      suggestion: `Investigate before trusting it; only then: ${accept(tool)}. Vendor signatures are a manual check (docs/THREAT_MODEL.md).`,
    },
  );
}

/** Win32: the shim changed but the program it starts did not — it may now start something else. */
function shimChangedRow(tool: string, pin: CliIdentity, m: Measured): Row {
  const was = pin.shim ? `${pin.shim.path} ${short(pin.shim.sha256)}` : "no shim";
  const now = m.shim ? `${m.shim.path} ${short(m.shim.sha256)}` : "no shim";
  return row(
    tool,
    "fail",
    `${tool}'s Windows .cmd shim changed (pinned ${was}; now ${now}) — possible tampering. kit refuses to run it until accepted`,
    {
      severity: "high",
      suggestion: `Read the shim before trusting it; only then: ${accept(tool)}`,
    },
  );
}

/** One tool's row. `versionOf` is only called when the hash changed. */
async function judgeVendorCli(
  tool: string,
  pins: Record<string, CliIdentity>,
  m: Measured | null,
  deps: Pick<PinDeps, "home" | "platform" | "arch">,
  versionOf: VersionOf = readCliVersion,
): Promise<Row> {
  const key = platformKey(deps);
  const pin = pins[key];
  if (!pin) return unpinnedRow(tool, m, Object.keys(pins).sort());
  if (!m) {
    return row(tool, "warn", `${tool} is pinned (${pin.version}, ${pin.path}) but not found`, {
      severity: "medium",
    });
  }
  const pinnedPath = expandPath(pin.path, deps.home);
  const isMoved = !samePath(pinnedPath, m.realpath, deps.platform);
  const moved = isMoved ? `; resolves to ${m.realpath}, pinned ${pin.path}` : "";
  if (m.sha256 !== pin.sha256) return changedHashRow(tool, pin, m, moved, versionOf);
  if (!sameShim(pin, m, deps)) return shimChangedRow(tool, pin, m);
  if (isMoved) {
    return row(
      tool,
      "warn",
      `${tool} resolves to ${m.realpath}, not the pinned ${pin.path} (PATH shadowing?); same sha256. kit refuses to run it until accepted`,
      { severity: "medium", suggestion: accept(tool) },
    );
  }
  return row(
    tool,
    "pass",
    `${tool} ${pin.version} matches its pin (sha256 ${short(pin.sha256)}, ${pin.path})`,
  );
}

export async function checkVendorCliPins(
  cwd: string,
  secrets: { store?: string; keys?: Record<string, { source?: string }> } | undefined,
  deps: PinDeps = defaultPinDeps(cwd),
  versionOf?: VersionOf,
): Promise<Row[]> {
  const all = await readAllPins(cwd);
  const tools = [...new Set([...projectVendorClis(secrets ?? {}), ...Object.keys(all)])].sort();
  if (tools.length === 0) {
    return [
      {
        category: "supply-chain",
        name: "vendor CLI pin",
        status: "skip",
        detail: "no vault or cloud CLI in [secrets] and nothing pinned in .kit/cli-lock.json",
      },
    ];
  }
  const rows: Row[] = [];
  for (const tool of tools) {
    let m: Measured | null;
    try {
      m = await measureCli(tool, deps);
    } catch (err) {
      if (err instanceof ShimUnreadable) {
        rows.push(row(tool, "fail", err.message, { severity: "high" }));
        continue;
      }
      m = null;
    }
    rows.push(await judgeVendorCli(tool, all[tool] ?? {}, m, deps, versionOf));
  }
  return rows;
}

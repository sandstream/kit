/**
 * `kit tools pin [<tool>...]` and `kit tools pin --accept <tool>...` — record, and explicitly
 * re-trust, the vendor-CLI identity pin (`vendor-cli-pin.ts`).
 *
 * - `pin` records the resolved realpath, SHA-256 and `--version` of each tool that has no pin for
 *   this platform yet. With no names it pins the vault/cloud CLIs the project's `[secrets]` uses.
 *   A tool whose pin no longer matches is refused here: re-trusting is `--accept`'s job alone.
 * - `--accept` replaces a pin with what is installed now. It takes explicit names only.
 *
 * Every write is preceded by an audit row (`vendor-cli-pin` / `vendor-cli-pin-accept`) carrying
 * the old and new identity. If the audit row cannot be written, the pin is not written. There is
 * no flag or environment variable that re-pins automatically.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import {
  defaultPinDeps,
  expandPath,
  identityFrom,
  measureCli,
  PINNABLE_CLIS,
  sameShim,
  ShimUnreadable,
  platformKey,
  projectVendorClis,
  readCliVersion,
  readPin,
  samePath,
  writePin,
  type CliIdentity,
  type Launch,
  type Measured,
  type PinDeps,
} from "../vendor-cli-pin.js";

export interface PinOutcome {
  tool: string;
  result: "pinned" | "accepted" | "unchanged" | "refused" | "error";
  detail: string;
  identity?: CliIdentity;
}

export interface PinIo {
  audit: (event: {
    operation: string;
    environment: string;
    success: boolean;
    metadata: Record<string, unknown>;
  }) => Promise<boolean>;
  /** Run with the measured launch: on win32 an npm shim is `node <entry>`, not the `.cmd`. */
  versionOf: (bin: string | Launch) => Promise<string | null>;
}

async function realIo(cwd: string): Promise<PinIo> {
  const { appendAuditEventDirect } = await import("../audit.js");
  return {
    audit: (event) => appendAuditEventDirect(event, { cwd }),
    versionOf: readCliVersion,
  };
}

function matches(pin: CliIdentity, m: Measured, deps: PinDeps): boolean {
  return (
    pin.sha256 === m.sha256 &&
    samePath(expandPath(pin.path, deps.home), m.realpath, deps.platform) &&
    sameShim(pin, m, deps)
  );
}

/** The tool measured, or the error outcome: not installed, or a win32 shim kit cannot read. */
async function measureForPin(tool: string, deps: PinDeps): Promise<Measured | PinOutcome> {
  try {
    const m = await measureCli(tool, deps);
    if (m) return m;
    return {
      tool,
      result: "error",
      detail: `${tool} is not installed (not found via mise or PATH)`,
    };
  } catch (err) {
    // A win32 shim kit cannot read is never pinned: kit could not run what it would pin.
    if (err instanceof ShimUnreadable) return { tool, result: "error", detail: err.message };
    throw err;
  }
}

/** Pin (or, with `accept`, re-trust) one tool. Never re-pins a changed tool without `accept`. */
export async function pinOne(
  tool: string,
  accept: boolean,
  deps: PinDeps,
  io: PinIo,
): Promise<PinOutcome> {
  const m = await measureForPin(tool, deps);
  if ("result" in m) return m;
  const existing = await readPin(tool, deps);
  if (existing && matches(existing, m, deps)) {
    return {
      tool,
      result: "unchanged",
      detail: `already pinned: ${existing.version} ${existing.sha256.slice(0, 12)}`,
    };
  }
  if (existing && !accept) {
    return {
      tool,
      result: "refused",
      detail: `pin differs (pinned ${existing.version} ${existing.sha256.slice(0, 12)} at ${existing.path}; now ${m.sha256.slice(0, 12)} at ${m.realpath}). Re-trust only with: kit tools pin --accept ${tool}`,
    };
  }
  const version = await io.versionOf(m.launch);
  if (!version)
    return { tool, result: "error", detail: `${tool} --version gave no version; not pinned` };
  const identity = identityFrom(m, version, deps.home);
  const operation = existing ? "vendor-cli-pin-accept" : "vendor-cli-pin";
  const audited = await io.audit({
    operation,
    environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
    success: true,
    metadata: { tool, platform: platformKey(deps), previous: existing ?? null, accepted: identity },
  });
  if (!audited)
    return { tool, result: "error", detail: "audit row could not be written; pin not changed" };
  await writePin(tool, identity, deps);
  return {
    tool,
    result: existing ? "accepted" : "pinned",
    detail: `${version} sha256 ${m.sha256} ${identity.path}${identity.shim ? ` (via shim ${identity.shim.path})` : ""}`,
    identity,
  };
}

const MARK: Record<PinOutcome["result"], string> = {
  pinned: `${c.green}✓${c.reset}`,
  accepted: `${c.green}✓${c.reset}`,
  unchanged: `${c.dim}=${c.reset}`,
  refused: `${c.red}✗${c.reset}`,
  error: `${c.red}✗${c.reset}`,
};

function usage(msg: string): boolean {
  console.error(`${c.red}${msg}${c.reset}`);
  console.error(
    `${c.dim}usage: kit tools pin [<tool>...] | kit tools pin --accept <tool>... [--json]${c.reset}`,
  );
  console.error(`${c.dim}pinnable: ${PINNABLE_CLIS.join(", ")}${c.reset}`);
  return false;
}

async function defaultTools(): Promise<string[]> {
  try {
    const { loadConfig } = await import("../config.js");
    const { resolveConfigPath } = await import("../cli-shared.js");
    return projectVendorClis((await loadConfig(resolveConfigPath())).secrets ?? {});
  } catch {
    return [];
  }
}

export async function cmdToolsPin(args: string[]): Promise<boolean> {
  const accept = hasFlag(args, "--accept");
  const json = hasFlag(args, "--json");
  const named = args.filter((a) => !a.startsWith("--"));
  const unknown = named.filter((t) => !PINNABLE_CLIS.includes(t));
  if (unknown.length) return usage(`not a pinnable vendor CLI: ${unknown.join(", ")}`);
  if (accept && named.length === 0)
    return usage("--accept takes the tool names to re-trust, explicitly");
  const tools = named.length ? named : await defaultTools();
  if (tools.length === 0) return usage("no vault or cloud CLI in [secrets]; name the tool to pin");
  const deps = defaultPinDeps();
  const io = await realIo(deps.cwd);
  const outcomes: PinOutcome[] = [];
  for (const tool of tools) outcomes.push(await pinOne(tool, accept, deps, io));
  if (json) console.log(JSON.stringify({ platform: platformKey(deps), outcomes }, null, 2));
  else {
    for (const o of outcomes)
      console.log(`  ${MARK[o.result]} ${o.tool}  ${o.result}  ${c.dim}${o.detail}${c.reset}`);
    console.log(
      `${c.dim}Recorded in .kit/cli-lock.json (commit it). This proves the binary is the one accepted, not that the vendor built it: verify vendor signatures by hand (docs/THREAT_MODEL.md).${c.reset}`,
    );
  }
  return outcomes.every((o) => o.result !== "refused" && o.result !== "error");
}

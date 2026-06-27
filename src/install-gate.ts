/**
 * Install-gate — make "installs nothing untriaged" true even in agent auto-mode.
 *
 * A rules-file instruction ("run kit triage before installing") only ADVISES; an
 * agent in auto/bypass mode can run `npm install evil` directly and the malicious
 * postinstall fires immediately — before any commit, so git hooks are too late.
 * The only real gate is a Claude Code (or Codex / Amazon Q) `PreToolUse` hook that
 * inspects the pending Bash command and BLOCKS it (exit 2) unless the package is
 * triaged.
 *
 * This module is the deterministic core: `parseInstallCommand` turns a raw Bash
 * string into kit triage refs (npm:/pip:), and `decideBashGate` triages each via
 * the existing `gateInstall` and returns a block/allow verdict. Pure + injectable
 * (no I/O here); the CLI wires it to stdin/exit-codes.
 *
 * Scope: the ecosystems kit can actually triage — npm (npm/pnpm/yarn/bun + npx)
 * and PyPI (pip/pip3/pipx/uv). Ecosystems kit has no triage for (cargo/go/gem/
 * brew) are passed through, NOT blocked, so the gate stays usable; that is an
 * honest scope limit, documented as such. Within scope it is FAIL-CLOSED: an
 * install whose target we cannot reduce to a clean registry name is blocked.
 */
import { gateInstall, type GateVerdict, type GateDeps } from "./triage-gate.js";

export interface InstallProbe {
  /** A package-manager add/install in a covered ecosystem was detected. */
  isInstall: boolean;
  /** kit triage refs to gate, e.g. ["npm:express", "pip:requests"]. */
  refs: string[];
  /** Covered-ecosystem install args we could not reduce to a clean ref (fail-closed → block). */
  unverifiable: string[];
}

/** Shell operators that separate independent commands in one Bash string. */
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;

/** A token is a flag (skip it) — `-g`, `--save-dev`, etc. */
function isFlag(tok: string): boolean {
  return tok.startsWith("-");
}

/**
 * A token is a LOCAL target (the user's own code / a file), not a registry
 * package — skip it (there is no reputation to triage). Covers `.`/`..`, relative
 * and absolute paths, home-relative, tarballs/wheels.
 */
function isLocalTarget(tok: string): boolean {
  if (tok === "." || tok === "..") return true;
  if (/^[./~]/.test(tok)) return true; // ./x  ../x  /abs  ~/x
  if (/\.(tgz|tar\.gz|whl)$/i.test(tok)) return true;
  return false;
}

/** A clean npm package name (optionally scoped, optionally @version) → bare name. */
function npmName(tok: string): string | null {
  // @scope/name(@version)?  or  name(@version)?
  const m = tok.match(/^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(@[^/\s]+)?$/i);
  return m ? m[1] : null;
}

/** A clean PyPI requirement (name plus optional extras/version spec) → bare name. */
function pipName(tok: string): string | null {
  // requests , requests==1.2 , requests[extra] , Flask>=2 — name is the leading run.
  const m = tok.match(/^([a-z0-9][\w.-]*)(\[[\w,.-]*\])?\s*([<>=!~].*)?$/i);
  return m ? m[1] : null;
}

interface Matcher {
  /** Does this segment's leading tokens start an in-scope install? Returns the index of the first ARG token, or -1. */
  argStart(tokens: string[]): number;
  scheme: "npm" | "pip";
  toName(tok: string): string | null;
}

/** Recognized package-manager invocations, by leading-token shape. */
const MATCHERS: Matcher[] = [
  // npm install|i|add <pkg...>, pnpm add|install, yarn add, bun add
  {
    scheme: "npm",
    toName: npmName,
    argStart: (t) => {
      const bin = t[0];
      if (bin === "npm" && /^(install|i|add)$/.test(t[1] ?? "")) return 2;
      if ((bin === "pnpm" || bin === "yarn" || bin === "bun") && /^(add|install|i)$/.test(t[1] ?? ""))
        return 2;
      return -1;
    },
  },
  // npx <pkg> — executes a package immediately (high risk)
  {
    scheme: "npm",
    toName: npmName,
    argStart: (t) => (t[0] === "npx" || t[0] === "bunx" ? 1 : -1),
  },
  // pip/pip3 install, pipx install, uv pip install, uv add, python -m pip install
  {
    scheme: "pip",
    toName: pipName,
    argStart: (t) => {
      if ((t[0] === "pip" || t[0] === "pip3" || t[0] === "pipx") && t[1] === "install") return 2;
      if (t[0] === "uv" && t[1] === "pip" && t[2] === "install") return 3;
      if (t[0] === "uv" && t[1] === "add") return 2;
      if (
        (t[0] === "python" || t[0] === "python3") &&
        t[1] === "-m" &&
        t[2] === "pip" &&
        t[3] === "install"
      )
        return 4;
      return -1;
    },
  },
];

/**
 * Parse a raw Bash command for in-scope package installs. Pure. Conservative:
 * bare `npm install` (no package args, i.e. reinstall declared deps) is NOT an
 * add and is ignored; local paths are ignored; a covered-ecosystem add whose
 * target is neither a clean name nor a local path is `unverifiable` (→ block).
 */
export function parseInstallCommand(command: string): InstallProbe {
  const probe: InstallProbe = { isInstall: false, refs: [], unverifiable: [] };
  if (!command || typeof command !== "string") return probe;

  for (const segment of command.split(SEGMENT_SPLIT)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    for (const m of MATCHERS) {
      const start = m.argStart(tokens);
      if (start < 0) continue;
      const args = tokens.slice(start).filter((t) => !isFlag(t));
      // No package args → reinstall of already-declared deps (or a runner with no
      // pkg). Not an "add"; don't gate.
      if (args.length === 0) break;
      probe.isInstall = true;
      for (const arg of args) {
        if (isLocalTarget(arg)) continue; // user's own code — nothing to triage
        const name = m.toName(arg);
        if (name) probe.refs.push(`${m.scheme}:${name}`);
        else probe.unverifiable.push(arg); // fail-closed: can't reduce to a ref
      }
      break; // one matcher per segment
    }
  }
  // De-dup refs (npm i a a, or a && a)
  probe.refs = [...new Set(probe.refs)];
  return probe;
}

export interface BashGateVerdict {
  block: boolean;
  reason: string;
  checked: GateVerdict[];
}

/**
 * Decide whether a Bash command should be blocked: triage every in-scope install
 * target via `gateInstall`. Fail-closed — any blocked target, or any
 * unverifiable in-scope arg, blocks the whole command.
 */
export async function decideBashGate(
  command: string,
  deps?: GateDeps,
): Promise<BashGateVerdict> {
  const probe = parseInstallCommand(command);
  if (!probe.isInstall) {
    return { block: false, reason: "no in-scope package install detected", checked: [] };
  }
  if (probe.unverifiable.length > 0) {
    return {
      block: true,
      reason: `cannot reduce to a triage target: ${probe.unverifiable.join(", ")} — run \`kit triage\` manually, or install via \`kit pkg\` (fail-closed)`,
      checked: [],
    };
  }
  const checked: GateVerdict[] = [];
  for (const ref of probe.refs) {
    const v = deps ? await gateInstall(ref, deps) : await gateInstall(ref);
    checked.push(v);
    if (v.decision === "blocked") {
      return { block: true, reason: v.reason, checked };
    }
  }
  return {
    block: false,
    reason:
      checked.length > 0
        ? `triage PASS: ${checked.map((c) => c.tool).join(", ")}`
        : "no registry targets to triage",
    checked,
  };
}

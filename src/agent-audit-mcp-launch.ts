/**
 * What a project's stdio MCP server runs when an agent session starts, beyond the malware shapes
 * `auditMcpStdio` fails on.
 *
 *   - **Repository code** (kit-research `artex-cc-vs-kit`): ARTEX-CC's committed `.mcp.json` runs
 *     `go run ./cmd/artex-cc serve`. Once the project server is approved, every session compiles
 *     and runs the checkout's own code, so a commit, a branch switch or a pulled change decides what
 *     runs, with the agent's credentials, before anyone reads it. `go run ./…`, `cargo run`,
 *     `node ./…` (and other interpreters on a relative path), `python -m <a package in the
 *     checkout>`, `npm|pnpm|yarn|bun run`, `uv run` and a relative command are named. A warning, not
 *     a failure: building your own server from source is normal in that server's own repository.
 *   - **An unpinned package runner** (kit-research `shrink-anything-vs-kit`): `npx -y <pkg>` and
 *     `uvx <pkg>` without a version run the newest published version at every session start.
 *     `kit triage skill` warned on that entry and `kit agent-audit` passed it, on purpose
 *     (see `auditMcpStdio`: a failure on every `npx` config is noise). Both now say "unpinned";
 *     here it is a low warning, not a failure. The runner list and the pinned test are the triage
 *     skill's (`skills/triage/scripts/plugin_scan.py`, `RUNNER`, `_runner_spec` and `_pinned`);
 *     `src/mcp-runner-pins.test-support.ts` holds the launches both are tested on.
 *
 * Read as data: nothing is resolved or run. Pure, except the directory check behind `python -m`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { shown } from "./agent-trifecta.js";
import type { SecurityCheckResult } from "./check-security.js";

export interface McpLaunch {
  server: string;
  command: string;
  argv: string[];
}

/** Stdio servers in a config view: `mcpServers`, `servers` or OpenCode's `mcp`. Pure. */
function stdioServers(json: string): McpLaunch[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: McpLaunch[] = [];
  for (const key of ["mcpServers", "servers", "mcp"]) {
    const servers = obj?.[key];
    if (!servers || typeof servers !== "object") continue;
    for (const [server, def] of Object.entries(servers as Record<string, unknown>)) {
      const launch = launchOf(server, def);
      if (launch) out.push(launch);
    }
  }
  return out;
}

function launchOf(server: string, def: unknown): McpLaunch | null {
  const raw = (def as { command?: unknown })?.command;
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : [];
  if (typeof raw === "string" && raw) {
    return { server, command: raw, argv: strs((def as { args?: unknown }).args) };
  }
  const parts = strs(raw);
  return parts.length ? { server, command: parts[0], argv: parts.slice(1) } : null;
}

function bin(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).replace(/\.(exe|cmd)$/i, "").toLowerCase();
}

const PROJECT_VARS = /^\$\{?(workspaceFolder|CLAUDE_PROJECT_DIR|PWD)\}?[\\/]/;

/** A path inside the checkout: `./x`, `../x`, `src/x.js`, `${workspaceFolder}/x`. */
function relativePath(arg: string): boolean {
  if (PROJECT_VARS.test(arg)) return true;
  if (arg.startsWith("-") || arg.startsWith("$") || arg.startsWith("~")) return false;
  if (arg.startsWith("/") || arg.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(arg)) return false;
  if (arg.startsWith("@")) return false; // an npm package spec
  if (/^[a-z][\w+.-]*:/i.test(arg)) return false; // jsr:, npm:, https:
  return arg.startsWith(".") || /[\\/]/.test(arg) || /\.(c?m?js|ts|py)$/i.test(arg);
}

const INTERPRETERS = new Set(["node", "bun", "deno", "tsx", "ts-node", "python", "python3", "py"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "cargo"]);

function firstOperand(argv: string[]): string | undefined {
  return argv.find((a) => !a.startsWith("-"));
}

/** `python -m pkg` where `pkg` is a directory or module file in the checkout. */
function localModule(argv: string[], root: string): string | null {
  const at = argv.indexOf("-m");
  const mod = at >= 0 ? argv[at + 1] : undefined;
  if (!mod || !/^[A-Za-z_][\w.]*$/.test(mod)) return null;
  const top = mod.split(".")[0];
  const there = [join(root, top), join(root, `${top}.py`), join(root, "src", top)];
  return there.some((p) => existsSync(p)) ? `-m ${mod}` : null;
}

/** What the server runs from the checkout, as the config spells it, or null. */
export function repoCodeLaunch(l: McpLaunch, root: string): string | null {
  const cmd = bin(l.command);
  const first = firstOperand(l.argv);
  if (relativePath(l.command) && !INTERPRETERS.has(cmd)) return l.command;
  const rest =
    cmd === "go" && first === "run"
      ? goTarget(l.argv)
      : SCRIPT_RUNNERS.has(cmd) && (first === "run" || first === "run-script")
        ? [first, firstOperand(l.argv.slice(l.argv.indexOf(first) + 1))].filter(Boolean).join(" ")
        : INTERPRETERS.has(cmd)
          ? interpreted(cmd, l.argv, root)
          : null;
  return rest ? `${cmd} ${rest}` : null;
}

/**
 * Go names a package in the checkout with a leading `.` (`./cmd/x`, `.`) or a `.go` file; anything
 * else (`github.com/x/y@v1`) is a module it downloads.
 */
function goTarget(argv: string[]): string | null {
  const target = argv.slice(argv.indexOf("run") + 1).find((a) => !a.startsWith("-"));
  const local =
    target && (target.startsWith(".") || target.endsWith(".go") || PROJECT_VARS.test(target));
  return local ? `run ${target}` : null;
}

/** An interpreter on a script in the checkout, or Python on a package in it. */
function interpreted(cmd: string, argv: string[], root: string): string | null {
  const mod = cmd.startsWith("py") ? localModule(argv, root) : null;
  if (mod) return mod;
  const script = firstOperand(cmd === "deno" && argv[0] === "run" ? argv.slice(1) : argv);
  return script && relativePath(script) ? script : null;
}

const RUNNERS = new Set(["npx", "bunx", "uvx"]);
const TWO_WORD = new Map([
  ["pnpm", "dlx"],
  ["yarn", "dlx"],
  ["pipx", "run"],
]);

/** Where a runner's package comes from: uvx and pipx install from PyPI, the rest from npm. */
const PYPI_RUNNERS = new Set(["uvx", "pipx run"]);
/** Options that name the package (`uvx --from x==1`, `npx -p x@1 x-cli`, `pipx run --spec x`). */
const SOURCE_OPTS = new Set(["--from", "--package", "--spec"]);
/** Options whose value is not the package (`uvx --python 3.12 x`). `-p` is uv's `--python`. */
const VALUE_OPTS = new Set([
  "--python",
  "--with",
  "--with-editable",
  "--with-requirements",
  "--index",
  "--index-url",
  "--extra-index-url",
  "--default-index",
  "--registry",
]);

/** The package a runner starts: the value of a source option given before it, or the first operand. */
function runnerSpec(runner: string, args: string[]): string | undefined {
  const pypi = PYPI_RUNNERS.has(runner);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) return a;
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    if (SOURCE_OPTS.has(name) || (name === "-p" && !pypi))
      return eq < 0 ? args[i + 1] : a.slice(eq + 1);
    if (eq < 0 && (VALUE_OPTS.has(name) || (name === "-p" && pypi))) i++;
  }
  return undefined;
}

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const PEP440 = String.raw`\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9.]+)?`;
const NPM_PIN = new RegExp(String.raw`^(?:@[\w.-]+/)?[\w.-]+@${SEMVER}$`);
const PYPI_PIN = new RegExp(
  String.raw`^[A-Za-z0-9][\w.-]*(?:\[[\w,.-]*\])?(?:==|@)${PEP440}$`,
  "i",
);
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const GIT_SOURCE = /git\+|git:\/\/|^(?:github|gitlab|bitbucket):|:\/\//;

/** A git or URL source: `git+https://…`, `github:o/r#…`; for npm also any spec with a `#` ref. */
function gitSource(spec: string, pypi: boolean): boolean {
  return GIT_SOURCE.test(spec) || (!pypi && spec.includes("#"));
}

/** The ref a git source names: after `#` for npm, after the last `@` of the URL path for uv and pip. */
function gitRef(spec: string, pypi: boolean): string {
  if (!pypi) return spec.split("#")[1] ?? "";
  const url = spec.includes("git+") ? spec.slice(spec.indexOf("git+")) : spec;
  const path = url.split("#")[0].split("://")[1] ?? "";
  return path.includes("@") ? path.slice(path.lastIndexOf("@") + 1) : "";
}

/**
 * The triage skill's `_pinned`, per ecosystem: npm `name@1.2.3` (an exact semver, not `^1`, `1`
 * or `latest`), PyPI `name==1.2.3` or uv's `name@1.2.3` (not `>=` or `~=`), and a git source only
 * by a full 40- or 64-hex commit. Anything else, ambiguous included, is unpinned.
 */
function pinned(spec: string, pypi: boolean): boolean {
  if (gitSource(spec, pypi)) return COMMIT.test(gitRef(spec, pypi));
  return (pypi ? PYPI_PIN : NPM_PIN).test(spec);
}

function pinAdvice(spec: string, pypi: boolean): string {
  if (gitSource(spec, pypi)) return `pin a full commit (${pypi ? "@" : "#"}<commit>)`;
  return `pin an exact version (${pypi ? "name==1.2.3" : "name@1.2.3"})`;
}

/** An unpinned runner launch: what it shows (`runner spec`) and how to pin it, or null. */
function unpinned(l: McpLaunch): { shown: string; advice: string } | null {
  const cmd = bin(l.command);
  let rest = l.argv;
  let runner = cmd;
  if (TWO_WORD.get(cmd) === l.argv[0]) {
    runner = `${cmd} ${l.argv[0]}`;
    rest = l.argv.slice(1);
  } else if (!RUNNERS.has(cmd)) return null;
  const spec = runnerSpec(runner, rest);
  const pypi = PYPI_RUNNERS.has(runner);
  if (!spec || spec.startsWith("$") || pinned(spec, pypi)) return null;
  return { shown: `${runner} ${spec}`, advice: pinAdvice(spec, pypi) };
}

/** `npx -y pkg`, `uvx pkg`, `pnpm dlx pkg` without a pin: the runner and the package. */
export function unpinnedRunner(l: McpLaunch): string | null {
  return unpinned(l)?.shown ?? null;
}

/** Rows for one project config: repository code at session start, and unpinned runners. */
export function mcpLaunchRows(view: string, root: string, rel: string): SecurityCheckResult[] {
  const rows: SecurityCheckResult[] = [];
  for (const l of stdioServers(view)) {
    const name = shown(l.server);
    const local = repoCodeLaunch(l, root);
    if (local) {
      rows.push({
        category: "exposure",
        name: `MCP server "${name}" in ${rel} runs repository code at session start`,
        status: "warn",
        severity: "low",
        detail: `\`${shown(local)}\` builds or runs this checkout's own code each time an agent starts the server, once the project server is approved: whatever a commit or branch puts there runs with the agent's credentials before anyone reads it`,
        suggestion:
          "review changes to that code like a hook; or run a pinned, installed release of the server instead",
      });
    }
    const runner = unpinned(l);
    if (runner) {
      rows.push({
        category: "exposure",
        name: `unpinned MCP runner "${name}" in ${rel}`,
        status: "warn",
        severity: "low",
        detail: `\`${shown(runner.shown)}\` runs the newest published version at every session start (unpinned), as \`kit triage skill\` reports it`,
        suggestion: `${runner.advice} so a new release is a change you make, not one that arrives`,
      });
    }
  }
  return rows;
}

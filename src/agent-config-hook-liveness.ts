/** Parse and validate installed gate commands before reporting them live. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { WRAPPER_MARKER } from "./kit-wrapper.js";
import { shellSplit } from "./utils/shellSplit.js";

export const GATE_SUBCOMMANDS = ["gate-bash", "gate-env", "gate-egress", "gate-fs"];

export function commandIncludesSubcommand(command: string, sub: string): boolean {
  try {
    return parseHookCommand(command).includes(sub);
  } catch {
    return command.endsWith(sub) || command.includes(` ${sub}`);
  }
}

function parseHookCommand(command: string): string[] {
  // POSIX shell escaping treats backslash as an escape. In cmd.exe it is a
  // literal path separator, including outside quotes.
  return shellSplit(process.platform === "win32" ? command.replace(/\\/g, "\\\\") : command);
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "$HOME" || path === "${HOME}") return homedir();
  if (path.startsWith("$HOME/")) return join(homedir(), path.slice("$HOME/".length));
  if (path.startsWith("${HOME}/")) return join(homedir(), path.slice("${HOME}/".length));
  return path;
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o111) !== 0;
}

function managedWrapperProblems(path: string): string[] {
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  if (!body.includes(WRAPPER_MARKER)) return [];
  const match = body.match(/exec "([^"]+)" "([^"]+)" "\$@"/);
  if (!match) {
    return [`managed kit wrapper is malformed: ${path}. Run: kit agent-config`];
  }
  const [, nodePath, cliPath] = match;
  const problems: string[] = [];
  if (!isExecutable(nodePath)) {
    problems.push(`managed kit wrapper points at missing/non-executable node: ${nodePath}`);
  }
  if (!existsSync(cliPath)) {
    problems.push(`managed kit wrapper points at missing kit CLI: ${cliPath}`);
  }
  return problems.map((p) => `${p}. Run: kit agent-config`);
}

export function hookCommandProblems(command: string): string[] {
  let argv: string[];
  try {
    argv = parseHookCommand(command);
  } catch (err) {
    return [
      `cannot parse hook command ${JSON.stringify(command)}: ${err instanceof Error ? err.message : String(err)}. Run: kit agent-config`,
    ];
  }
  if (argv.length === 0) return ["empty hook command. Run: kit agent-config"];
  let exe = argv[0];
  if (exe === "exec" && argv[1]) exe = argv[1];
  if (exe === "kit") {
    return [
      "hook command uses bare `kit`; non-login hook shells often lack PATH setup, causing exit 127. Run: kit agent-config",
    ];
  }
  const expanded = expandHomePath(exe);
  if (!isAbsolute(expanded)) {
    return [
      `hook command uses non-absolute executable \`${exe}\`; non-login hook shells may not resolve it. Run: kit agent-config`,
    ];
  }
  // A `/root/…` path is suspicious only when `/root` is NOT this machine's home. That is
  // the case this check was added for: a hook command generated in a root sandbox, carried
  // to a normal account, where the path is unreachable and every gated tool call dies with
  // exit 127. When HOME really IS /root — a root container, which is where agents commonly
  // run — the same path is native and works, so returning here reported a command that
  // starts fine as one that "cannot reliably start", and told the operator to rewrite hooks
  // for /root when /root is exactly where they already pointed. Falling through leaves the
  // `isExecutable` check below, which still catches a genuinely broken /root path.
  if (expanded.startsWith("/root/") && homedir() !== "/root") {
    return [
      `hook command points at ${expanded}, which looks like a root/container path on this machine. Run: kit agent-config in this repo to rewrite hooks for ${homedir()}`,
    ];
  }
  if (!isExecutable(expanded)) {
    return [`hook command target missing or not executable: ${expanded}. Run: kit agent-config`];
  }
  if (/^node(?:\.exe)?$/i.test(basename(expanded)) && argv[1] && !argv[1].startsWith("-")) {
    const entry = expandHomePath(argv[1]);
    if (!isAbsolute(entry) || !existsSync(entry)) {
      return [`hook command kit CLI missing: ${entry}. Run: kit agent-config`];
    }
  }
  return managedWrapperProblems(expanded);
}

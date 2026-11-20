/**
 * Is the wired gate kit? `enforcement gate liveness` checks that a gate command parses, is
 * absolute and is executable; `enforcement evidence` runs its negative controls against kit's own
 * build. Neither looked at what the wired command is, so a settings entry pointing at any
 * executable that exits 0 passed both (kit-research `verify-against-real-state-vs-kit`).
 *
 * This resolves each gate command to the kit entrypoint it would start, by reading files only:
 *   - `node <cli.js> …`;
 *   - a kit-managed wrapper (POSIX or `.cmd`) whose exec line names node and a `cli.js`;
 *   - a link or npm shim that resolves to a `cli.js`.
 * The entrypoint counts as kit when the nearest `package.json` above it is named `sandstream-kit`.
 * Nothing the settings file names is executed: the file is repository content.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  GATE_SUBCOMMANDS,
  commandIncludesSubcommand,
  expandHomePath,
  kitVersionAt,
  parseHookCommand,
} from "./agent-config-hook-liveness.js";
import { groupsIn } from "./gate-settings.js";
import { WRAPPER_MARKER } from "./kit-wrapper.js";

export type GateIdentity =
  | { command: string; kit: true; version: string; cliPath: string }
  | { command: string; kit: false; target: string; why: string };

const WRAPPER_READ_LIMIT = 64 * 1024;

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A small file's text, read through one descriptor (size and content from the same file), or null. */
function readSmall(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (fstatSync(fd).size > WRAPPER_READ_LIMIT) return null;
    return readFileSync(fd, "utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The node + cli.js a kit-managed wrapper runs, or null when `path` is not one. */
function wrapperEntry(path: string): string | null {
  const body = readSmall(path);
  if (body === null || !body.includes(WRAPPER_MARKER)) return null;
  const posix = body.match(/exec "[^"]+" "([^"]+)" "\$@"/);
  if (posix) return posix[1];
  const cmd = body.match(/^"[^"]+" "([^"]+)" %\*\s*$/m);
  return cmd ? cmd[1] : null;
}

/** The cli.js an npm `.cmd` shim runs (`"%dp0%\…\cli.js"`), resolved against the shim's folder. */
function npmCmdShimEntry(path: string): string | null {
  if (!/\.cmd$/i.test(path)) return null;
  const body = readSmall(path);
  const m = body?.match(/"%~?dp0%?\\?([^"]*?cli\.js)"/i);
  return m ? resolve(dirname(path), m[1].replace(/\\/g, "/")) : null;
}

/** The kit entrypoint a gate command would start, or why none can be named. */
function entryOf(command: string): { entry: string } | { why: string; target: string } {
  let argv: string[];
  try {
    argv = parseHookCommand(command);
  } catch {
    return { why: "the command cannot be parsed", target: command };
  }
  let i = argv[0] === "exec" ? 1 : 0;
  const exe = expandHomePath(argv[i] ?? "");
  if (!isAbsolute(exe)) return { why: "the executable is not an absolute path", target: exe };
  if (/^node(?:\.exe)?$/i.test(basename(exe))) {
    i += 1;
    const cli = argv[i] ? expandHomePath(argv[i]) : "";
    return cli && isAbsolute(cli)
      ? { entry: cli }
      : { why: "node is not given an absolute script", target: exe };
  }
  const fromWrapper = wrapperEntry(exe) ?? npmCmdShimEntry(exe);
  if (fromWrapper) return { entry: fromWrapper };
  const real = realOrSelf(exe);
  if (/\.(?:c|m)?js$/i.test(real)) return { entry: real };
  return {
    why: "it is not node, a kit-managed wrapper, or a link to a kit entrypoint",
    target: exe,
  };
}

/** Resolve one gate command to the kit it runs, by reading files only. */
export function identifyGate(command: string): GateIdentity {
  const found = entryOf(command);
  if ("why" in found) return { command, kit: false, target: found.target, why: found.why };
  if (!existsSync(found.entry)) {
    return { command, kit: false, target: found.entry, why: "its entrypoint does not exist" };
  }
  const version = kitVersionAt(found.entry);
  if (version === null) {
    return {
      command,
      kit: false,
      target: found.entry,
      why: "the entrypoint is not in the sandstream-kit package",
    };
  }
  return { command, kit: true, version, cliPath: realOrSelf(found.entry) };
}

/** The gate-bash and gate-env commands Claude Code would run here: project, local and user settings. */
function wiredGateCommands(root: string, home: string = homedir()): string[] {
  const files = [
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
    join(home, ".claude", "settings.json"),
  ];
  const wanted = GATE_SUBCOMMANDS.filter((s) => s === "gate-bash" || s === "gate-env");
  return files
    .flatMap((f) => groupsIn(f))
    .flatMap((g) => g.hooks ?? [])
    .map((h) => h.command)
    .filter((cmd): cmd is string => typeof cmd === "string")
    .filter((cmd) => wanted.some((sub) => commandIncludesSubcommand(cmd, sub)));
}

export interface GateIdentityFacts {
  /** Gate commands that do not resolve to kit, with the reason. */
  notKit: { target: string; why: string }[];
  /** Kit versions other than the running one that a gate runs. */
  otherVersions: string[];
}

/** Every wired gate checked against the kit that is running. */
export function gateIdentityFacts(
  root: string,
  runningVersion: string,
  home: string = homedir(),
): GateIdentityFacts {
  const ids = wiredGateCommands(root, home).map(identifyGate);
  const notKit = ids.flatMap((id) => (id.kit ? [] : [{ target: id.target, why: id.why }]));
  const otherVersions = [
    ...new Set(
      ids.flatMap((id) =>
        id.kit && runningVersion !== "unknown" && id.version !== runningVersion ? [id.version] : [],
      ),
    ),
  ];
  return { notKit, otherVersions };
}

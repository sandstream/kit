/**
 * `gate-self-edit` for Codex's hook config (kit-research `agent-vm-yolo-herdr-paseo-vs-kit`: after
 * `kit agent-config`, `sed -i '/gate-bash/d' .codex/config.toml`, `rm .codex/config.toml` and a
 * Write to it all passed the gates with exit 0, while the same edits to `.claude/settings.json`
 * were refused).
 *
 * Codex reads hooks from a `[hooks]` table in each config layer's `config.toml` and from a
 * `hooks.json` beside it: the project's `.codex/` and the user's `$CODEX_HOME` (default `~/.codex`).
 * `kit agent-config` writes kit's gate into the project `.codex/config.toml`
 * (`writeInstallGateCodex` in `agent-config.ts`); the other three are guarded the same way when a
 * person put kit's gate there.
 *
 * A file holds kit's gate when one of its hook handlers runs a kit gate subcommand. A write to such
 * a file is refused when the result drops or changes one of those handlers (its event, matcher or
 * command: Codex stops running a hook whose matcher changes), when the result no longer parses, or
 * when it cannot be computed. A write that keeps every one of them passes.
 *
 * Pure text functions; the caller reads the files and computes the resulting text.
 */
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

import { GATE_SUBCOMMANDS, commandIncludesSubcommand } from "./agent-config-hook-liveness.js";

/** The four files Codex reads hooks from: project then user, `config.toml` then `hooks.json`. */
export function codexHookTargets(cwd: string, home: string, codexHome?: string): string[] {
  const user = codexHome ? resolve(codexHome) : join(home, ".codex");
  return [
    resolve(cwd, ".codex", "config.toml"),
    resolve(cwd, ".codex", "hooks.json"),
    join(user, "config.toml"),
    join(user, "hooks.json"),
  ];
}

function parseConfig(path: string, text: string): unknown {
  try {
    return /\.toml$/i.test(path) ? parseToml(text) : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `event|matcher|command` of one handler when its command runs a kit gate, else null. */
function gateEntry(event: string, matcher: unknown, handler: unknown): string | null {
  const command = (handler as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return null;
  if (!GATE_SUBCOMMANDS.some((sub) => commandIncludesSubcommand(command, sub))) return null;
  return `${event}|${typeof matcher === "string" ? matcher : ""}|${command}`;
}

/**
 * Every hook handler of a Codex hook file that runs a kit gate, as `event|matcher|command`; null
 * when the text does not parse. `path` picks TOML or JSON by its extension.
 */
function codexGateEntries(path: string, text: string): string[] | null {
  const cfg = parseConfig(path, text);
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const hooks = (cfg as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: string[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const { matcher, hooks: handlers } = (group ?? {}) as { matcher?: unknown; hooks?: unknown };
      for (const handler of Array.isArray(handlers) ? handlers : []) {
        const entry = gateEntry(event, matcher, handler);
        if (entry) out.push(entry);
      }
    }
  }
  return out;
}

/** Whether a Codex hook file's text holds kit's gate. */
export function holdsCodexGate(path: string, text: string | null): boolean {
  return text !== null && (codexGateEntries(path, text) ?? []).length > 0;
}

/**
 * Why a write to a Codex hook file is refused, or null. `next` null: the result cannot be computed
 * from the tool input.
 */
export function codexHookWriteRefusal(
  path: string,
  current: string | null,
  next: string | null,
  name: string,
): string | null {
  const wired = current === null ? [] : (codexGateEntries(path, current) ?? []);
  if (wired.length === 0) return null;
  if (next === null) return `the edit to ${name} cannot be checked against kit's Codex gate hook`;
  const after = codexGateEntries(path, next);
  if (after === null) {
    return `the write would leave ${name} unparseable, which turns kit's Codex gate off`;
  }
  if (wired.some((entry) => !after.includes(entry))) {
    return `the write would remove or change kit's gate hook in ${name}; run \`kit agent-config\` to change it`;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A Codex hook file named in a shell command: `.codex/config.toml` or `.codex/hooks.json` (which
 * also covers `~/.codex/...`), the same files under `$CODEX_HOME`, or under the literal Codex home
 * path. A file reached through `cd` alone is not seen.
 */
export function codexHookFileName(codexHome?: string): RegExp {
  const file = String.raw`[\\/](?:config\.toml|hooks\.json)\b`;
  const homes = [String.raw`\.codex`, String.raw`\$\{?CODEX_HOME\}?`];
  if (codexHome) homes.push(escapeRegExp(resolve(codexHome)));
  return new RegExp(`(?:${homes.join("|")})${file}`, "i");
}

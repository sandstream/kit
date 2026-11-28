/**
 * Is kit's Codex install gate (`kit gate-bash` in `.codex/config.toml`) one Codex will run?
 *
 * A hook in a Codex config file does not run because it is in the file. Codex (openai/codex at
 * 8727186a0a0e097f5e4496ba830f5d59c235b88c) needs two approvals, both stored in the USER config
 * (`$CODEX_HOME/config.toml`), never in the project:
 *
 *   1. Project trust. A project `.codex/config.toml` layer is loaded but disabled until the
 *      project is trusted (`codex-rs/config/src/loader/mod.rs:143-145`), stored as
 *      `[projects."<path>"] trust_level = "trusted"` (`loader/mod.rs:1110-1170`).
 *   2. Hook trust. Each non-managed hook runs only when its trust status is `Trusted`
 *      (`codex-rs/hooks/src/engine/discovery.rs:953-960`): the user layer holds
 *      `[hooks.state."<key>"] trusted_hash = "sha256:…"` (`codex-rs/hooks/src/config_rules.rs:23-40`)
 *      and it equals the hook's current hash (`discovery.rs:1072-1089`). Any change to the
 *      matcher or the handler changes the hash, and the hook stops running again (`Modified`).
 *
 * The key is `<source path>:<event label>:<group index>:<handler index>`
 * (`codex-rs/hooks/src/lib.rs:126-136`), the source path being the project's `.codex/config.toml`
 * (`discovery.rs:456-465`). The hash is `version_for_toml` (`codex-rs/config/src/fingerprint.rs:56-69`:
 * SHA-256 of the key-sorted compact JSON) over `{event_name, matcher, hooks: [normalized handler]}`
 * (`discovery.rs:1045-1070`), the handler normalized as in `discovery.rs:705-735`.
 *
 * kit reads this and reports it. It never writes `trusted_hash`: trusting a hook is the user's
 * decision, made in Codex (`/hooks`, or the startup hook review).
 *
 * Liveness (kit-research `agent-vm-yolo-herdr-paseo-vs-kit`): `kit agent-config` records that it
 * wired the gate in a machine-local marker, `.codex/.kit-gate-installed`, as it does for Claude
 * Code's gates. Where the marker is present and kit's gate is gone from `.codex/config.toml`, the
 * row fails and names `kit agent-config`; before, the row disappeared and `kit check` went quieter.
 * No marker and no gate: kit never wired it here, and there is no row.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { SecurityCheckResult } from "./check-security.js";
import { codexHome } from "./agent-audit-user.js";
import { codexTrusts, pathKey, rootKeys } from "./check-pretrusted.js";
import { commandIncludesSubcommand } from "./agent-config-hook-liveness.js";
import { isKitGateCommand } from "./kit-gate-command.js";

/** Codex's default command-hook timeout in seconds (`discovery.rs:1040`). */
const DEFAULT_TIMEOUT_SEC = 600;
/** `DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT` (`codex-rs/hooks/src/output_spill.rs:13`), dropped from the hash. */
const DEFAULT_CONTEXT_LIMIT = 2500;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** serde_json's `sort_all_objects` + compact `to_vec`: keys in byte order at every depth. Pure. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `version_for_toml`: `sha256:` + hex SHA-256 of the canonical JSON. Pure. */
export function codexVersionHash(value: Json): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** A `[[hooks.<Event>.hooks]]` command handler as written in TOML. */
export interface CodexCommandHandler {
  type?: unknown;
  command?: unknown;
  commandWindows?: unknown;
  command_windows?: unknown;
  timeout?: unknown;
  async?: unknown;
  statusMessage?: unknown;
  onFailure?: unknown;
  additionalContextLimit?: unknown;
}

/**
 * The trust hash Codex computes for one command handler of a `PreToolUse` group. `platform`
 * picks `commandWindows` over `command` on Windows, as Codex does (`discovery.rs:690-694`). Pure.
 */
export function codexCommandHookHash(
  eventLabel: string,
  matcher: string | undefined,
  handler: CodexCommandHandler,
  platform: NodeJS.Platform = process.platform,
): string {
  const windowsCommand = handler.commandWindows ?? handler.command_windows;
  const command =
    platform === "win32" && typeof windowsCommand === "string" ? windowsCommand : handler.command;
  const timeout = typeof handler.timeout === "number" ? Math.max(1, handler.timeout) : null;
  const normalized: { [k: string]: Json } = {
    type: "command",
    command: String(command ?? ""),
    timeout: timeout ?? DEFAULT_TIMEOUT_SEC,
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage;
  if (handler.onFailure === "continue" || handler.onFailure === "block") {
    normalized.onFailure = handler.onFailure;
  }
  if (
    typeof handler.additionalContextLimit === "number" &&
    handler.additionalContextLimit !== DEFAULT_CONTEXT_LIMIT
  ) {
    normalized.additionalContextLimit = handler.additionalContextLimit;
  }
  const identity: { [k: string]: Json } = { event_name: eventLabel, hooks: [normalized] };
  if (matcher !== undefined) identity.matcher = matcher;
  return codexVersionHash(identity);
}

/** One `kit gate-bash` handler in a project `.codex/config.toml`, with its Codex key and hash. */
export interface CodexGateHook {
  groupIndex: number;
  handlerIndex: number;
  hash: string;
  /** The exact command Codex will show in /hooks, and the user is asked to trust. */
  command: string;
}

/** PreToolUse command handlers in a Codex config's text, with their indexes. Pure. */
function preToolUseHandlers(
  configToml: string,
): { groupIndex: number; handlerIndex: number; matcher?: string; handler: CodexCommandHandler }[] {
  let cfg: unknown;
  try {
    cfg = parseToml(configToml);
  } catch {
    return [];
  }
  const groups = (cfg as { hooks?: { PreToolUse?: unknown } })?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return [];
  const found: ReturnType<typeof preToolUseHandlers> = [];
  groups.forEach((group: { matcher?: unknown; hooks?: unknown }, groupIndex) => {
    if (!Array.isArray(group?.hooks)) return;
    const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
    group.hooks.forEach((handler: CodexCommandHandler, handlerIndex) => {
      if (handler?.type !== "command" || typeof handler.command !== "string") return;
      found.push({ groupIndex, handlerIndex, matcher, handler });
    });
  });
  return found;
}

/** The command Codex runs for a handler on `platform` (`discovery.rs:690-694`). Pure. */
function effectiveCommand(handler: CodexCommandHandler, platform: NodeJS.Platform): string {
  const windows = handler.commandWindows ?? handler.command_windows;
  return platform === "win32" && typeof windows === "string" ? windows : String(handler.command);
}

/**
 * kit's own `gate-bash` PreToolUse handlers: the command Codex runs is exactly a line kit writes
 * (src/kit-gate-command.ts). A handler that only mentions gate-bash is not kit's, and kit never
 * asks the user to trust it. Pure.
 */
export function codexGateHooks(
  configToml: string,
  platform: NodeJS.Platform = process.platform,
): CodexGateHook[] {
  return preToolUseHandlers(configToml)
    .filter(({ handler }) => isKitGateCommand(effectiveCommand(handler, platform), "gate-bash"))
    .map(({ groupIndex, handlerIndex, matcher, handler }) => ({
      groupIndex,
      handlerIndex,
      hash: codexCommandHookHash("pre_tool_use", matcher, handler, platform),
      command: effectiveCommand(handler, platform),
    }));
}

/** PreToolUse handlers that mention gate-bash but are not a line kit writes. Pure. */
export function codexLookalikeCount(
  configToml: string,
  platform: NodeJS.Platform = process.platform,
): number {
  return preToolUseHandlers(configToml).filter(({ handler }) => {
    const command = effectiveCommand(handler, platform);
    return (
      commandIncludesSubcommand(command, "gate-bash") && !isKitGateCommand(command, "gate-bash")
    );
  }).length;
}

/** `[hooks.state."<key>"]` entries of a user config, keyed by Codex's own key string. Pure. */
function hookStates(userToml: string): Map<string, { trusted_hash?: unknown; enabled?: unknown }> {
  let cfg: unknown;
  try {
    cfg = parseToml(userToml);
  } catch {
    return new Map();
  }
  const state = (cfg as { hooks?: { state?: unknown } })?.hooks?.state;
  if (!state || typeof state !== "object") return new Map();
  return new Map(Object.entries(state as Record<string, { trusted_hash?: unknown }>));
}

/** Split `<path>:<event>:<g>:<h>` from the right (a Windows path holds a `:`). Pure. */
function splitHookKey(key: string): { path: string; event: string; g: number; h: number } | null {
  const m = /^(.*):([a-z_]+):(\d+):(\d+)$/.exec(key.trim());
  if (!m) return null;
  return { path: m[1], event: m[2], g: Number(m[3]), h: Number(m[4]) };
}

export type CodexHookTrust = "trusted" | "untrusted" | "modified" | "disabled";

/** The trust of one gate hook, read from the user config's text. `configKeys` are the
 *  comparison keys of the project's `.codex/config.toml` path. Pure. */
function codexHookTrust(
  hook: CodexGateHook,
  userToml: string,
  configKeys: Set<string>,
): CodexHookTrust {
  for (const [key, state] of hookStates(userToml)) {
    const k = splitHookKey(key);
    if (!k || k.event !== "pre_tool_use") continue;
    if (k.g !== hook.groupIndex || k.h !== hook.handlerIndex) continue;
    if (!configKeys.has(pathKey(k.path))) continue;
    if (state?.enabled === false) return "disabled";
    if (typeof state?.trusted_hash !== "string") return "untrusted";
    return state.trusted_hash === hook.hash ? "trusted" : "modified";
  }
  return "untrusted";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** The keys a project's `.codex/config.toml` can appear under in a hook-state key. */
function configPathKeys(root: string): Set<string> {
  const file = join(root, ".codex", "config.toml");
  const paths = [file, resolve(file)];
  try {
    paths.push(realpathSync(file));
  } catch {
    // a missing file still matches by its given path
  }
  return new Set(paths.map((p) => pathKey(p)));
}

/** What Codex will do with kit's gate in `root`; null when kit's Codex gate is not there. */
export interface CodexGateStatus {
  projectTrusted: boolean;
  /** Handlers that mention gate-bash but are not kit's: never to be trusted as kit's gate. */
  lookalikes: number;
  hooks: (CodexGateHook & { trust: CodexHookTrust })[];
  /** How the user config was named in output (`~/.codex` or `$CODEX_HOME`). */
  shown: string;
}

export function codexGateStatus(
  root: string,
  home: string,
  env: Record<string, unknown> = process.env,
): CodexGateStatus | null {
  const project = readText(join(root, ".codex", "config.toml"));
  if (project === null) return null;
  const hooks = codexGateHooks(project);
  const lookalikes = codexLookalikeCount(project);
  if (hooks.length === 0 && lookalikes === 0) return null;
  const codex = codexHome(home, env);
  const user = readText(join(codex.dir, "config.toml")) ?? "";
  const keys = configPathKeys(root);
  return {
    projectTrusted: codexTrusts(user, rootKeys(root)),
    lookalikes,
    hooks: hooks.map((h) => ({ ...h, trust: codexHookTrust(h, user, keys) })),
    shown: codex.shown,
  };
}

/** The steps a person takes to make Codex run kit's gate; empty when it already runs. Pure. */
export function codexActivationSteps(root: string, status: CodexGateStatus): string[] {
  const steps: string[] = [];
  if (status.hooks.length === 0) {
    steps.push(
      "Run `kit agent-config` to add kit's own gate-bash hook; the one in .codex/config.toml is not kit's.",
    );
  }
  if (!status.projectTrusted) {
    steps.push(
      `Codex ignores .codex/config.toml until you trust this project: start \`codex\` in ${root} and accept the trust prompt (Codex stores it in ${status.shown}/config.toml).`,
    );
  }
  const pending = status.hooks.filter((h) => h.trust !== "trusted");
  if (pending.length > 0) {
    const why = pending.some((h) => h.trust === "modified")
      ? "the hook changed after you trusted it, so Codex stopped running it"
      : pending.some((h) => h.trust === "disabled")
        ? "the hook is turned off in Codex"
        : "Codex runs a new hook only after you trust it";
    const commands = pending.map((h) => `\`${h.command}\``).join(" or ");
    steps.push(
      `In Codex, open /hooks (or answer the startup hook review) and trust the PreToolUse hook in .codex/config.toml whose command is exactly ${commands}: ${why}. Trust no other hook as kit's gate.`,
    );
  }
  if (status.lookalikes > 0) {
    steps.push(
      `Do not trust the ${status.lookalikes} other PreToolUse hook(s) in .codex/config.toml that mention gate-bash: their command is not one kit writes. Read them, and remove any you did not add.`,
    );
  }
  if (steps.length > 0) {
    steps.push(
      "Then run `kit check --category security` and confirm the row `codex install-gate trust` passes. kit never writes the trust itself.",
    );
  }
  return steps;
}

/** Machine-local marker that `kit agent-config` wired kit's Codex gate here (beside the config). */
function codexGateMarkerPath(root: string): string {
  return join(root, ".codex", ".kit-gate-installed");
}

/** Record that kit's Codex gate is wired here (best-effort; never throws). */
export function markCodexGateInstalled(root: string): void {
  try {
    writeFileSync(codexGateMarkerPath(root), new Date().toISOString() + "\n");
  } catch {
    /* advisory: a failed marker never fails the install */
  }
}

/** The fail row for a Codex gate kit wired here that is gone now. */
function codexGateMissingRow(status: CodexGateStatus | null): SecurityCheckResult {
  const lookalikes = status?.lookalikes
    ? `; ${status.lookalikes} gate-bash look-alike hook(s) there are not kit's`
    : "";
  return {
    category: "exposure",
    name: "codex install-gate liveness",
    status: "fail",
    severity: "high",
    detail: `kit wired its gate-bash hook into .codex/config.toml on this machine (.codex/.kit-gate-installed), and it is gone${lookalikes}. Codex runs installs ungated`,
    suggestion:
      "Run: kit agent-config (it writes kit's gate-bash hook back into .codex/config.toml); then trust it in Codex and re-run kit check --category security",
  };
}

/**
 * `kit check` rows: fail when kit wired its Codex gate here and it is gone; warn while it is present
 * but not one Codex will run.
 */
export function checkCodexHookTrust(
  root: string,
  home: string,
  env: Record<string, unknown> = process.env,
): SecurityCheckResult[] {
  const status = codexGateStatus(root, home, env);
  if (!status?.hooks.length && existsSync(codexGateMarkerPath(root))) {
    return [codexGateMissingRow(status)];
  }
  if (!status) return [];
  const steps = codexActivationSteps(root, status);
  if (steps.length === 0) {
    return [
      {
        category: "exposure",
        name: "codex install-gate trust",
        status: "pass",
        detail: `Codex trusts this project and kit's gate-bash hook (${status.shown}/config.toml)`,
      },
    ];
  }
  const states = status.hooks.map((h) => h.trust).join(", ") || "not kit's";
  const lookalikes =
    status.lookalikes > 0 ? `; ${status.lookalikes} gate-bash look-alike hook(s), not kit's` : "";
  const runs = status.hooks.length > 0 && status.hooks.every((h) => h.trust === "trusted");
  return [
    {
      category: "exposure",
      name: "codex install-gate trust",
      status: "warn",
      severity: "medium",
      detail: `kit's gate-bash hook in .codex/config.toml: project ${
        status.projectTrusted ? "trusted" : "not trusted"
      }, hook ${states}${lookalikes}. ${runs && status.projectTrusted ? "kit's gate runs" : "Codex installs run ungated"}`,
      suggestion: steps.join(" "),
    },
  ];
}

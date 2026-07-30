/**
 * kit guard — PATH-shim delivery of the install gate for HUMAN terminals.
 *
 * The agent loop is already gated (PreToolUse `gate-bash` across 11 harnesses),
 * but a human typing `npm i evil` / `npx evil` / `brew install evil` in their
 * own shell reaches the machine ungated. This module puts the SAME hardened
 * parser + triage verdict (`parseInstallCommand` / `decideBashGate`) in front
 * of the package managers via ~/.kit/shims/<tool> + a PATH prepend.
 *
 * v1 is OBSERVE-ONLY by design (the exec-broker discipline: observe → evidence
 * → enforce). A shim never blocks and never breaks the tool: kit missing,
 * crashing, or slow ⇒ the real binary still runs — the worst failure mode of a
 * guard is breaking `npm` itself. Every shim is marker-tagged and writers
 * refuse to clobber a file the user authored.
 *
 * Env knobs: KIT_GUARD_BYPASS=1 skips observation entirely (shim still execs
 * the real tool); KIT_GUARD_DIR / KIT_GUARD_LOG / KIT_GUARD_RC override paths
 * (tests + unusual homes).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The fetch-and-run + install front doors worth standing a guard at. */
export const GUARD_TOOLS: readonly string[] = [
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "uvx",
  "brew",
  "gem",
  "cargo",
];

export const SHIM_MARKER = "# kit-managed guard shim (do not edit)";
export const RC_BEGIN = "# BEGIN kit guard (managed block — edit outside the markers)";
export const RC_END = "# END kit guard";

export function guardShimsDir(): string {
  return process.env.KIT_GUARD_DIR ?? join(homedir(), ".kit", "shims");
}

export function guardLogPath(): string {
  return process.env.KIT_GUARD_LOG ?? join(homedir(), ".kit", "guard-observe.jsonl");
}

/** Shell rc files the PATH block goes into (existing ones + ~/.zshrc as the macOS default). */
export function guardRcFiles(): string[] {
  const override = process.env.KIT_GUARD_RC;
  if (override) return override.split(":").filter(Boolean);
  const home = homedir();
  const zshrc = join(home, ".zshrc");
  const bashrc = join(home, ".bashrc");
  const out = [zshrc]; // created if missing — zsh is the macOS default shell
  if (existsSync(bashrc)) out.push(bashrc);
  return out;
}

/**
 * The POSIX-sh shim for one tool. Pure — unit-tested as text. Contract:
 *  1. observe first (best-effort, silenced, NEVER gating): `kit guard-observe`
 *     logs what the install gate would decide;
 *  2. then exec the REAL binary — first PATH match outside the shims dir;
 *  3. kit missing/crashing changes nothing; a missing real binary exits 127
 *     like a shell would.
 */
export function generateShim(tool: string, shimsDir: string): string {
  return `#!/bin/sh
${SHIM_MARKER}
# kit guard v1 (observe): logs what kit's install gate WOULD decide, then
# ALWAYS runs the real ${tool}. Never blocks; kit unavailable => unchanged
# behavior. Bypass: KIT_GUARD_BYPASS=1. Remove: kit guard uninstall.
if [ -z "\${KIT_GUARD_BYPASS:-}" ] && command -v kit >/dev/null 2>&1; then
  kit guard-observe ${tool} "$@" >/dev/null 2>&1 || true
fi
_kit_shims="${shimsDir}"
_old_ifs="\${IFS}"
IFS=:
for _d in \$PATH; do
  IFS="\${_old_ifs}"
  [ -n "\${_d}" ] || continue
  [ "\${_d}" = "\${_kit_shims}" ] && continue
  if [ -x "\${_d}/${tool}" ]; then
    exec "\${_d}/${tool}" "$@"
  fi
done
IFS="\${_old_ifs}"
echo "kit-guard: ${tool} not found on PATH (beyond the shim) — run: kit guard uninstall" >&2
exit 127
`;
}

/** The managed rc block that puts the shims first on PATH. Pure. */
export function rcBlock(shimsDir: string): string {
  return `${RC_BEGIN}
# kit guard (observe mode): package-manager shims log what kit's install gate
# would decide. \`kit guard status\` shows observations; \`kit guard uninstall\` removes.
export PATH="${shimsDir}:$PATH"
${RC_END}`;
}

/** Insert/replace the managed block in an rc file's content. Pure. */
export function upsertRcBlock(content: string, block: string): string {
  const begin = content.indexOf(RC_BEGIN);
  const end = content.indexOf(RC_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return content.slice(0, begin) + block + content.slice(end + RC_END.length);
  }
  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}\n${block}\n`;
}

/** Remove the managed block (and its trailing newline) from rc content. Pure. */
export function stripRcBlock(content: string): string {
  const begin = content.indexOf(RC_BEGIN);
  const end = content.indexOf(RC_END);
  if (begin === -1 || end === -1 || end < begin) return content;
  let tail = content.slice(end + RC_END.length);
  if (tail.startsWith("\n")) tail = tail.slice(1);
  let head = content.slice(0, begin);
  if (head.endsWith("\n\n")) head = head.slice(0, -1);
  return head + tail;
}

export interface GuardObservation {
  ts: string;
  cwd: string;
  tool: string;
  /** The reconstructed command, truncated — context, not forensics. */
  command: string;
  wouldBlock: boolean;
  reason: string;
  refs: string[];
}

/** Append one observation (0600 file, 0700 dir). Best-effort: a logging failure
 *  must never surface into the user's package-manager call. */
export function appendObservation(obs: GuardObservation): void {
  try {
    const path = guardLogPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(obs) + "\n", { mode: 0o600 });
  } catch {
    // observe is best-effort by contract
  }
}

/** Read the observation log (missing/corrupt rows skipped — never throws). */
export function readObservations(): GuardObservation[] {
  try {
    const lines = readFileSync(guardLogPath(), "utf-8").split("\n").filter(Boolean);
    const out: GuardObservation[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as GuardObservation);
      } catch {
        // one corrupt row never hides the rest
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Write a shim file, refusing to clobber a non-kit file. Returns what happened. */
export function writeShim(tool: string, dir: string): "written" | "kept-foreign" {
  const path = join(dir, tool);
  if (existsSync(path) && !readFileSync(path, "utf-8").includes(SHIM_MARKER)) {
    return "kept-foreign";
  }
  writeFileSync(path, generateShim(tool, dir), { mode: 0o755 });
  return "written";
}

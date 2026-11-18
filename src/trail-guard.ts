/**
 * kit's own trail, kept out of reach of the agent it records. Pure: reads a command or a write
 * target, never the files.
 *
 * kit-research `agent-swarms-security-guide-vs-kit` measured that an agent running as the same
 * user could delete `.kit-audit.jsonl`, write one row and run `kit audit anchor`, after which
 * `kit audit verify` exited 0, and that no gate refused any of those steps. These rules close the
 * tool-call path:
 *
 *   - **Refused writes:** a Write/Edit whose target is `.kit-audit.jsonl` or `.kit-approvals.jsonl`
 *     (any directory), or anything under `~/.kit/`.
 *   - **Refused shell segments:**
 *     - any segment that names the anchor key or record (`audit-anchor.key`, `audit-anchor.json`):
 *       reading the key is enough to forge a seal;
 *     - a segment that names a trail file or a `~/.kit/` path and starts with a command that
 *       changes files (`rm`, `mv`, `truncate`, `sed`, `Remove-Item`, …) or redirects output into
 *       it;
 *     - `kit audit anchor` and `kit panic`, which re-seal or rotate on the agent's behalf.
 *
 * Reading the log (`cat`, `kit audit verify`) and running the `~/.kit/bin/kit` wrapper stay
 * allowed. A person runs the refused commands themselves (with `!` in Claude Code). Out of
 * scope: a script the agent wrote earlier and runs now, or any process outside the gated tools.
 * That boundary is external anchoring (`kit audit anchor --external`).
 */
import { basename, isAbsolute, relative, resolve } from "node:path";

/** Trail files in a project root. */
const TRAIL_FILES = [".kit-audit.jsonl", ".kit-approvals.jsonl"];

/** The anchor key and record: naming either at all is refused. */
const ANCHOR_FILES = /audit-anchor\.(?:key|json)\b/;

/** Commands that change, move or delete the files they name. */
const MUTATING = new Set([
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "cp",
  "ln",
  "truncate",
  "shred",
  "dd",
  "tee",
  "sed",
  "perl",
  "chmod",
  "chown",
  "install",
  "rsync",
  "touch",
  "del",
  "erase",
  "move",
  "copy",
  "ren",
  "remove-item",
  "clear-content",
  "set-content",
  "add-content",
  "out-file",
  "move-item",
  "copy-item",
  "rename-item",
]);

/** Prefixes that run the next word as the command. */
const WRAPPERS = new Set(["sudo", "doas", "command", "builtin", "exec", "nohup", "env", "time"]);

/** A home `.kit` directory reference, in the spellings a shell or an agent uses. */
function homeKitPattern(home: string): RegExp {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\|\//g, "[\\\\/]");
  return new RegExp(
    `(?:~|\\$HOME|\\$\\{HOME\\}|%USERPROFILE%|\\$env:USERPROFILE|${escaped})[\\\\/]\\.kit(?:[\\\\/]|\\b)`,
    "i",
  );
}

function namesTrail(segment: string, home: string): boolean {
  return TRAIL_FILES.some((f) => segment.includes(f)) || homeKitPattern(home).test(segment);
}

/** The first command word of a segment, past variable assignments and wrappers, lower-cased. */
function commandWord(segment: string): string {
  const words = segment.trim().split(/\s+/);
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const name = basename(word.replace(/^["']|["']$/g, ""))
      .toLowerCase()
      .replace(/\.exe$/, "");
    if (WRAPPERS.has(name)) continue;
    return name;
  }
  return "";
}

/** Whether a segment redirects output into a trail file or a `~/.kit/` path. */
function redirectsIntoTrail(segment: string, home: string): boolean {
  for (const m of segment.matchAll(/>{1,2}\|?\s*("[^"]*"|'[^']*'|\S+)/g)) {
    if (namesTrail(m[1] ?? "", home)) return true;
  }
  return false;
}

/** Why a shell command is refused, or null when it leaves kit's trail alone. */
export function trailCommandRefusal(command: string, home: string): string | null {
  if (/(^|[\s/\\"'])kit(?:\.cmd)?["']?\s+(?:audit\s+anchor|panic)\b/i.test(command)) {
    return "`kit audit anchor` and `kit panic` re-seal or rotate kit's trail; a person runs them, not the agent";
  }
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (ANCHOR_FILES.test(segment)) {
      return "the command names the audit anchor key or record, which is enough to forge or erase the seal";
    }
    if (!namesTrail(segment, home)) continue;
    if (MUTATING.has(commandWord(segment)) || redirectsIntoTrail(segment, home)) {
      return "the command changes or deletes kit's audit trail, approvals or ~/.kit";
    }
  }
  return null;
}

/** Why a file write is refused, or null when its target is not part of kit's trail. */
export function trailWriteRefusal(filePath: string, cwd: string, home: string): string | null {
  const abs = resolve(cwd, filePath);
  if (TRAIL_FILES.includes(basename(abs))) {
    return `a write to ${basename(abs)} would change kit's audit trail`;
  }
  const rel = relative(resolve(home, ".kit"), abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return "a write under ~/.kit would change kit's keys, anchor or state";
  }
  return null;
}

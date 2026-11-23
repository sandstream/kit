/**
 * Which agents a repository lets post an approving review that GitHub counts.
 *
 * kit's "default branch required reviews" row reported "1 approval(s) required: pass". With
 * Anthropic's Claude Approvals, a policy file can let Claude post that approval, and its docs say
 * *"Claude's approving review can meet a GitHub branch rule that requires one approval"*
 * (kit-research `claude-ship-vs-kit`). A change on those paths can then merge with no person
 * approving, and kit's row stayed green.
 *
 * kit works with every agent, not one vendor's. Each tool that can approve gets a reader here:
 *   - **Claude Approvals:** `.claude/approvals.yml` or `.claude/approvals.yaml`, in the root or a
 *     subdirectory, where a rule's verdict says `claude: approves`.
 *   - **OpenAI Codex:** no reader. Its GitHub code review posts comments; its documentation,
 *     read 2026-11-23, describes no setting that makes it approve a pull request. Its review rules
 *     live in `AGENTS.md`.
 * A new tool that can approve is one more entry in `READERS`.
 *
 * The policy files are read from tracked files (`git ls-files`), the closest local fact to "on the
 * default branch", which is where the tools read them. Not parsed as YAML (kit has no YAML
 * dependency, ADR-0002): a line scan. A policy whose top-level `mode` is `observe` approves
 * nothing and is not reported. A single rule in observe mode is still reported, which can warn
 * where the tool would not approve; the row names the lines so a person can check.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentApprover {
  /** The tool, as people know it ("Claude Approvals"). */
  tool: string;
  /** The policy file, relative to the repository root. */
  file: string;
  /** 1-based lines where the policy lets the agent approve. */
  lines: number[];
}

interface Reader {
  tool: string;
  file: RegExp;
  approves: RegExp;
  observe: RegExp;
}

const READERS: Reader[] = [
  {
    tool: "Claude Approvals",
    file: /(^|\/)\.claude\/approvals\.ya?ml$/,
    approves: /\bclaude\s*:\s*["']?approves\b/,
    observe: /^mode\s*:\s*["']?observe\b/,
  },
];

const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "");

/** The approving lines of one policy text, or none when it is in observe mode. Pure. */
export function approvingLines(
  text: string,
  reader: Pick<Reader, "approves" | "observe">,
): number[] {
  const lines = text.split(/\r?\n/).map(stripComment);
  if (lines.some((l) => reader.observe.test(l))) return [];
  return lines.map((l, i) => (reader.approves.test(l) ? i + 1 : 0)).filter((n) => n > 0);
}

/** Every tracked policy file that lets an agent approve. Never throws. */
export function agentApprovers(root: string, tracked?: string[]): AgentApprover[] {
  let files = tracked;
  if (!files) {
    try {
      files = execFileSync("git", ["-C", root, "ls-files", "-z"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\0")
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  const out: AgentApprover[] = [];
  for (const file of files) {
    const reader = READERS.find((r) => r.file.test(file));
    if (!reader) continue;
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const lines = approvingLines(text, reader);
    if (lines.length > 0) out.push({ tool: reader.tool, file, lines });
  }
  return out;
}

/** "Claude Approvals (.claude/approvals.yml lines 5, 9)", for at most three files. */
export function describeApprovers(approvers: AgentApprover[]): string {
  const shown = approvers.slice(0, 3).map((a) => {
    const at =
      a.lines.length === 1 ? `line ${a.lines[0]}` : `lines ${a.lines.slice(0, 5).join(", ")}`;
    return `${a.tool} (${a.file} ${at})`;
  });
  const more = approvers.length > 3 ? ` and ${approvers.length - 3} more file(s)` : "";
  return shown.join(", ") + more;
}

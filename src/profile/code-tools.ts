/**
 * Code an agent runs as its tools, frozen in the profile.
 *
 * With "code execution with MCP" (Anthropic) the agent sees each MCP tool as a file it calls from
 * code, for example `servers/<server>/<tool>.ts`, and it may save working code as a skill for its
 * next run (`skills/`). Those files are the tool definitions and the agent's toolbox: an edit to
 * `updateRecord.ts` changes what a tool does without any tool call a gate can see (kit-research
 * `mcp-code-mode-vs-kit`).
 *
 * Which files: the operator lists globs in `.kit-profile.toml`, for example
 * `code_tool_paths = ["servers/**", "skills/**"]`. kit does not guess, because a `servers/`
 * directory is just as often application code. The files are walked, not read from git, so a file
 * the agent added and nobody committed is found too.
 *
 * Each file is a component: its POSIX path relative to the project, and the first 16 hex digits of
 * a SHA-256 of its bytes. `.git` and `node_modules` are skipped, symbolic links are not followed,
 * and at most 2,000 files are read.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { globToRegExp } from "../adr.js";
import type { DiscoveredComponent } from "./reconcile.js";

const MAX_FILES = 2_000;
const SKIP = new Set([".git", "node_modules"]);

/** The directory a glob can match under: its segments before the first wildcard. Pure. */
export function globBase(glob: string): string {
  const parts = glob.replaceAll("\\", "/").split("/");
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?[]/.test(part)) break;
    fixed.push(part);
  }
  // A glob without wildcards names a file; walk its directory.
  if (fixed.length === parts.length) fixed.pop();
  return fixed.join("/");
}

function walk(root: string, base: string, out: string[]): void {
  const stack = [join(root, ...base.split("/").filter(Boolean))];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
      if (out.length >= MAX_FILES) return;
    }
  }
}

/**
 * The files the declared globs match, each with its content hash; null when no glob is declared,
 * so a profile without `code_tool_paths` is not judged on code tools at all.
 */
export function discoverCodeTools(
  root: string,
  globs: readonly string[] | undefined,
): DiscoveredComponent[] | null {
  if (!globs || globs.length === 0) return null;
  const patterns = globs.map((g) => globToRegExp(g));
  const candidates: string[] = [];
  for (const base of new Set(globs.map(globBase))) walk(root, base, candidates);
  const files = [...new Set(candidates)].filter((f) => patterns.some((re) => re.test(f))).sort();
  return files.map((name) => {
    try {
      const version = createHash("sha256")
        .update(readFileSync(join(root, ...name.split("/"))))
        .digest("hex")
        .slice(0, 16);
      return { name, version };
    } catch {
      return { name };
    }
  });
}

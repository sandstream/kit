/** Static code checks for access grants, Dockerfile secrets and disabled guards. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "vendor",
  "target",
]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 256 * 1024;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|java|cs|go|php)$/i;
const SHELL_FILE = /\.(?:sh|bash|zsh|command)$/i;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const CLOUD_COMMAND = /^(?:(?:sudo|env|if)\s+)*(?:gcloud|aws|az|kubectl|terraform|ufw|iptables)\b/i;
const PUBLIC_FLAG =
  /--member(?:=|\s+)allUsers\b|--ingress(?:=|\s+)all\b|--allow-unauthenticated\b|0\.0\.0\.0\/0(?![\d.])/i;
const SECRET_NAME =
  /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*_(?:PASSWORD|SECRET|TOKEN))\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/gi;

type RuleId = "L2-cloud-public" | "L2-docker-env-secret" | "L2-commented-guard";
interface Hit {
  file: string;
  line: number;
  indicator: string;
}

function suppressed(lines: string[], line: number, rule: RuleId): boolean {
  const marker = new RegExp(`\\bkit-ignore\\s+${rule}:\\s*\\S`, "i");
  return marker.test(lines[line] ?? "") || marker.test(lines[line - 1] ?? "");
}

function candidates(root: string): { files: string[]; errors: string[] } {
  const files: string[] = [];
  const errors: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 16 || files.length >= MAX_FILES) {
      errors.push("file or depth limit reached");
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      errors.push(`cannot list ${relative(root, dir) || "."}`);
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        errors.push("file limit reached");
        break;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path, depth + 1);
      } else if (entry.isFile()) {
        const name = relative(root, path).replaceAll("\\", "/");
        if (
          SHELL_FILE.test(name) ||
          WORKFLOW_FILE.test(name) ||
          /^Dockerfile(?:\..+)?$/i.test(entry.name) ||
          SOURCE_FILE.test(name)
        )
          files.push(name);
      }
    }
  };
  visit(root, 0);
  return { files: files.sort(), errors };
}

function logicalLines(lines: string[]): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = i;
    let text = lines[i] ?? "";
    while (/\\\s*$/.test(text) && i + 1 < lines.length) {
      text = text.replace(/\\\s*$/, " ") + (lines[++i] ?? "");
    }
    out.push({ text, line: first });
  }
  return out;
}

function scanCloud(lines: string[], file: string, hits: Hit[]): void {
  for (const { text, line } of logicalLines(lines)) {
    const command = text.trim().replace(/^(?:-\s*)?run:\s*/i, "");
    if (/^(?:#|\/\/)/.test(command)) continue;
    for (const part of command.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
      if (!CLOUD_COMMAND.test(part.trim())) continue;
      const flag = PUBLIC_FLAG.exec(part);
      if (flag && !suppressed(lines, line, "L2-cloud-public"))
        hits.push({ file, line: line + 1, indicator: flag[0] });
    }
  }
}

function isLiteral(value: string): boolean {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  return unquoted.length > 0 && !/\$|\{\{/.test(unquoted);
}

function scanDockerfile(lines: string[], file: string, hits: Hit[]): void {
  for (const { text, line } of logicalLines(lines)) {
    const env = /^\s*ENV\s+(.+)$/i.exec(text);
    if (!env || suppressed(lines, line, "L2-docker-env-secret")) continue;
    const assignments = env[1] ?? "";
    SECRET_NAME.lastIndex = 0;
    for (const match of assignments.matchAll(SECRET_NAME)) {
      if (isLiteral(match[2] ?? "")) hits.push({ file, line: line + 1, indicator: match[1] ?? "" });
    }
    // Docker also permits the old two-argument ENV form.
    const old = /^([A-Za-z_][A-Za-z0-9_]*_(?:PASSWORD|SECRET|TOKEN))\s+(.+)$/i.exec(assignments);
    if (old && !assignments.includes("=") && isLiteral(old[2] ?? ""))
      hits.push({ file, line: line + 1, indicator: old[1] ?? "" });
  }
}

function scanGuards(lines: string[], file: string, hits: Hit[]): void {
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*if\s*\([^;]*\)\s*\{\s*(.*)$/.exec(lines[i] ?? "");
    if (!open || suppressed(lines, i, "L2-commented-guard")) continue;
    let commentedControl = /^\/\/\s*(?:throw|return)\b/.test((open[1] ?? "").trim());
    let closed = /^\/\/.*\}\s*$/.test((open[1] ?? "").trim());
    let active = false;
    for (let j = i + 1; !closed && j < Math.min(lines.length, i + 16); j++) {
      const body = (lines[j] ?? "").trim();
      if (!body) continue;
      if (/^\}\s*;?$/.test(body)) {
        closed = true;
        break;
      }
      if (/^(?:\/\/|\/\*|\*|\*\/)/.test(body)) {
        if (/^(?:\/\/|\/\*|\*)\s*(?:throw|return)\b/.test(body)) commentedControl = true;
        continue;
      }
      active = true;
      break;
    }
    if (closed && commentedControl && !active)
      hits.push({ file, line: i + 1, indicator: "disabled throw/return" });
  }
}

function result(
  name: string,
  category: "exposure" | "secrets",
  hits: Hit[],
  severity: "high" | "medium",
): SecurityCheckResult {
  return hits.length
    ? {
        category,
        name,
        status: "fail",
        severity,
        detail: `${hits.length} finding(s): ${hits
          .slice(0, 5)
          .map((h) => `${h.file}:${h.line} (${h.indicator})`)
          .join(", ")}${hits.length > 5 ? `, +${hits.length - 5} more` : ""}`,
        files: [...new Set(hits.map((h) => h.file))],
        suggestion:
          "Remove the unsafe setting or add a rule-specific kit-ignore comment with a reason.",
      }
    : { category, name, status: "pass", detail: "no matching unsafe code pattern" };
}

/** Scan the supplied project root without invoking shell commands or reading generated trees. */
export async function checkCodeGuardrails(root: string): Promise<SecurityCheckResult[]> {
  const cloud: Hit[] = [];
  const docker: Hit[] = [];
  const guards: Hit[] = [];
  const { files, errors } = candidates(root);
  for (const file of files) {
    let content: string;
    try {
      const path = join(root, file);
      if (statSync(path).size > MAX_FILE_BYTES) {
        errors.push(`file too large: ${file}`);
        continue;
      }
      content = readFileSync(path, "utf8");
    } catch {
      errors.push(`cannot read ${file}`);
      continue;
    }
    const lines = content.split(/\r?\n/);
    if (SHELL_FILE.test(file) || WORKFLOW_FILE.test(file)) scanCloud(lines, file, cloud);
    if (/^Dockerfile(?:\..+)?$/i.test(basename(file))) scanDockerfile(lines, file, docker);
    if (
      SOURCE_FILE.test(file) &&
      !/(?:^|\/)(?:tests?|fixtures?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file)
    )
      scanGuards(lines, file, guards);
  }
  const results = [
    result("public cloud command", "exposure", cloud, "high"),
    result("literal Dockerfile secret", "secrets", docker, "high"),
    result("commented-out guard", "exposure", guards, "medium"),
  ];
  if (errors.length) {
    const detail = `${errors.length} source path(s) were not scanned: ${errors.slice(0, 3).join(", ")}`;
    for (const row of results) {
      if (row.status !== "pass") continue;
      row.status = "warn";
      row.didNotRun = true;
      row.detail = detail;
    }
  }
  return results;
}

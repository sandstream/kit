// `kit triage prompt "<text>"`: read a pasted install prompt before an agent follows it.
// The text is data: nothing it names is fetched, cloned or run.
import { c } from "./utils/colors.js";
import {
  INSTRUCTION_SCAN_FLOOR,
  sanitizeInstructionDisplay,
  scanInstructionText,
  type InstructionFinding,
} from "./instruction-scan-text.js";

export const UNVERSIONED =
  "the target is unversioned: what runs is whatever it serves when fetched";

export interface PromptUrl {
  url: string;
  host: string;
}

export interface PromptClone {
  url: string;
  /** `owner/repo` when the clone is from github.com, which `kit triage repo` reads. */
  ownerRepo: string | null;
}

export interface PromptTriage {
  findings: InstructionFinding[];
  urls: PromptUrl[];
  clones: PromptClone[];
  nextSteps: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** `git clone`, its options, then the first token shaped like a remote (URL or scp-style). */
const CLONE_RE = /\bgit\s+clone\b[^\n]*?\s((?:https?|ssh|git):\/\/\S+|[\w.-]+@[\w.-]+:\S+)/gi;
const GITHUB_RE =
  /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** A URL as written, without the sentence punctuation or closing bracket that follows it. */
function trimUrl(raw: string): string {
  let url = raw.replace(/["'`]+$/, "").replace(/[.,;:!?]+$/, "");
  while (/[)\]]$/.test(url)) {
    const open = url.endsWith(")") ? "(" : "[";
    const close = url.slice(-1);
    if (url.split(open).length >= url.split(close).length) break;
    url = url.slice(0, -1).replace(/[.,;:!?]+$/, "");
  }
  return url;
}

function urlsOf(text: string): PromptUrl[] {
  const seen = new Map<string, PromptUrl>();
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!seen.has(url)) seen.set(url, { url, host });
  }
  return [...seen.values()];
}

function clonesOf(text: string): PromptClone[] {
  const clones: PromptClone[] = [];
  for (const m of text.matchAll(CLONE_RE)) {
    const url = trimUrl(m[1]);
    const gh = GITHUB_RE.exec(url);
    clones.push({ url, ownerRepo: gh ? `${gh[1]}/${gh[2]}` : null });
  }
  return clones;
}

function nextStepsFor(urls: PromptUrl[], clones: PromptClone[]): string[] {
  const steps: string[] = [];
  const cloned = new Set(clones.map((clone) => clone.url));
  if (urls.some((u) => !cloned.has(u.url)))
    steps.push(
      "for a fetched instruction file: save it without running it, then `kit triage instructions <fetched file>`",
    );
  for (const clone of clones) {
    if (clone.ownerRepo) steps.push(`before cloning: \`kit triage repo ${clone.ownerRepo}\``);
    else
      steps.push(`${clone.url}: not a GitHub repository, so \`kit triage repo\` cannot score it`);
  }
  if (clones.length)
    steps.push(
      "after cloning, before an agent loads it: `kit triage skill <cloned dir>` and `kit triage instructions <cloned dir>`",
    );
  return steps;
}

/** Triage a pasted prompt. Pure: no fetch, no clone, no execution. */
export function triagePrompt(text: string): PromptTriage {
  const urls = urlsOf(text);
  const clones = clonesOf(text);
  return {
    findings: scanInstructionText("prompt", text),
    urls,
    clones,
    nextSteps: nextStepsFor(urls, clones),
  };
}

/** The report lines, uncoloured except for the marks. Every echoed piece of the text is sanitized. */
export function renderPromptTriage(t: PromptTriage): string[] {
  const out = [`${c.bold}kit triage prompt${c.reset}`];
  for (const f of t.findings)
    out.push(`  ${c.red}✗${c.reset} line ${f.line} [${f.rule}] ${f.excerpt}`);
  for (const u of t.urls)
    out.push(
      `  ${c.yellow}!${c.reset} url ${sanitizeInstructionDisplay(u.url)} (host ${sanitizeInstructionDisplay(u.host)})`,
    );
  if (t.urls.length) out.push(`  ${c.yellow}!${c.reset} ${UNVERSIONED}`);
  const verdict = t.findings.length
    ? `${c.red}${t.findings.length} finding(s)${c.reset}`
    : `${c.green}no finding${c.reset}`;
  out.push(`\n  prompt read, nothing fetched or run: ${verdict}.`);
  if (t.nextSteps.length) {
    out.push("  Next:");
    for (const step of t.nextSteps) out.push(`    ${sanitizeInstructionDisplay(step)}`);
  }
  out.push(`  ${c.dim}${INSTRUCTION_SCAN_FLOOR}${c.reset}`);
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Succeed only when the text has no finding, as `kit triage instructions` does. */
export async function cmdTriagePrompt(args: string[]): Promise<boolean> {
  const words = args.filter((a) => a === "-" || !a.startsWith("--"));
  const fromStdin = words.length === 0 || (words.length === 1 && words[0] === "-");
  if (fromStdin && process.stdin.isTTY) {
    console.error(
      'kit triage prompt: give the text as an argument, or pipe it on stdin: kit triage prompt "<text>"',
    );
    return false;
  }
  const text = fromStdin ? await readStdin() : words.join(" ");
  const triage = triagePrompt(text);
  for (const line of renderPromptTriage(triage)) console.log(line);
  return triage.findings.length === 0;
}

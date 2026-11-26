/**
 * Read-only GitHub reads for `kit review gate`: the pull request, its files, its head's check runs,
 * the default branch's CI state and the protected-path rules on the default branch.
 *
 * Node's fetch, REST only, GET only. Every list is paged explicitly (per_page=100&page=N). A read
 * that fails is recorded as unread instead of thrown, so the command can still say what it saw;
 * any unread entry makes the verdict incomplete, never approve. The token, when one is given, goes
 * only into the Authorization header and is never part of a message.
 */
import { checksState, mainRed, type CheckRun, type ChecksState } from "./review-gate.js";
import {
  DEFAULT_PROTECTED_PATH_RULES,
  parseProtectedPathRules,
  type ProtectedPathRules,
} from "./review-protected-paths.js";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const RULE_PATH = ".github/kit-protected-paths.json";
const MAX_PAGES = 30;

class NotFound extends Error {}

export interface GitHubReader {
  get(path: string, accept?: string): Promise<unknown>;
  paged(path: string, key?: string): Promise<{ items: unknown[]; truncated: boolean }>;
}

export function gitHubReader(token: string | undefined, fetcher: Fetcher = fetch): GitHubReader {
  const get = async (path: string, accept = "application/vnd.github+json") => {
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(`${API}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers,
    });
    if (response.status === 404) throw new NotFound(`GET ${path}: HTTP 404`);
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return accept.includes("raw") ? response.text() : response.json();
  };
  const paged = async (path: string, key?: string) => {
    const items: unknown[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = (await get(`${path}${sep}per_page=100&page=${page}`)) as Record<string, unknown>;
      const batch = key ? body[key] : body;
      if (!Array.isArray(batch)) throw new Error(`GET ${path}: not a list`);
      items.push(...batch);
      if (batch.length < 100) return { items, truncated: false };
    }
    return { items, truncated: true };
  };
  return { get, paged };
}

interface Pull {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  headSha: string;
}

export interface GateReads {
  pull: Pull | null;
  paths: string[];
  changedLines: number;
  fileCount: number;
  truncated: boolean;
  checks: ChecksState | null;
  main: { branch: string; sha: string; red: string[] } | null;
  rules: ProtectedPathRules;
  /** "repo" when the default branch has the rule file, "default" for kit's built-in rules. */
  rulesSource: "repo" | "default" | "unread";
  unread: string[];
}

const SHA = /^[0-9a-f]{40}$/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asPull(value: unknown): Pull {
  const p = value as {
    number?: unknown;
    state?: unknown;
    draft?: unknown;
    merged?: unknown;
    head?: { sha?: unknown };
  };
  const headSha = String(p?.head?.sha ?? "");
  if (!SHA.test(headSha)) throw new Error("the pull request has no head commit");
  return {
    number: Number(p.number),
    state: String(p.state),
    draft: p.draft === true,
    merged: p.merged === true,
    headSha,
  };
}

async function readFiles(reader: GitHubReader, repo: string, n: number, reads: GateReads) {
  const files = await reader.paged(`/repos/${repo}/pulls/${n}/files`);
  const rows = files.items as {
    filename?: string;
    previous_filename?: string;
    additions?: number;
    deletions?: number;
  }[];
  reads.paths = rows.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean) as string[]);
  reads.changedLines = rows.reduce((sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  reads.fileCount = rows.length;
  reads.truncated = files.truncated;
}

async function readRuns(reader: GitHubReader, repo: string, sha: string) {
  const runs = await reader.paged(`/repos/${repo}/commits/${sha}/check-runs`, "check_runs");
  if (runs.truncated) throw new Error(`more than ${MAX_PAGES * 100} check runs on ${sha}`);
  return runs.items as CheckRun[];
}

async function readMain(reader: GitHubReader, repo: string, reads: GateReads) {
  const { default_branch: branch } = (await reader.get(`/repos/${repo}`)) as {
    default_branch?: string;
  };
  if (!branch) throw new Error("the repository has no default branch");
  const head = (await reader.get(`/repos/${repo}/commits/${encodeURIComponent(branch)}`)) as {
    sha?: string;
  };
  const sha = String(head.sha ?? "");
  if (!SHA.test(sha)) throw new Error(`the default branch ${branch} has no head commit`);
  reads.main = { branch, sha, red: mainRed(await readRuns(reader, repo, sha)) };
}

async function readRules(reader: GitHubReader, repo: string, reads: GateReads) {
  const ref = reads.main?.sha;
  if (!ref) throw new Error("the default branch was not read");
  try {
    const text = await reader.get(
      `/repos/${repo}/contents/${RULE_PATH}?ref=${ref}`,
      "application/vnd.github.raw+json",
    );
    reads.rules = parseProtectedPathRules(String(text));
    reads.rulesSource = "repo";
  } catch (error) {
    if (!(error instanceof NotFound)) throw error;
    reads.rules = DEFAULT_PROTECTED_PATH_RULES;
    reads.rulesSource = "default";
  }
}

async function attempt(reads: GateReads, label: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    reads.unread.push(`could not read ${label}: ${message(error)}`);
  }
}

/**
 * Every read the gate needs, at the pull request's current head. The head is read again at the
 * end: if it moved in between, the reads mix two commits, and that is unread too.
 */
export async function readGate(reader: GitHubReader, repo: string, n: number): Promise<GateReads> {
  const reads: GateReads = {
    pull: null,
    paths: [],
    changedLines: 0,
    fileCount: 0,
    truncated: false,
    checks: null,
    main: null,
    rules: DEFAULT_PROTECTED_PATH_RULES,
    rulesSource: "unread",
    unread: [],
  };
  await attempt(reads, "the pull request", async () => {
    reads.pull = asPull(await reader.get(`/repos/${repo}/pulls/${n}`));
  });
  const head = reads.pull?.headSha;
  if (!head) return reads;
  await attempt(reads, "the changed files", () => readFiles(reader, repo, n, reads));
  await attempt(reads, "the head's check runs", async () => {
    reads.checks = checksState(await readRuns(reader, repo, head));
  });
  await attempt(reads, "the default branch's CI", () => readMain(reader, repo, reads));
  await attempt(reads, `${RULE_PATH} on the default branch`, () => readRules(reader, repo, reads));
  await attempt(reads, "the pull request again", async () => {
    const now = asPull(await reader.get(`/repos/${repo}/pulls/${n}`)).headSha;
    if (now !== head)
      throw new Error(`the head moved from ${head.slice(0, 12)} to ${now.slice(0, 12)}; run again`);
  });
  return reads;
}

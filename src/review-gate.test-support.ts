/**
 * A stubbed GitHub REST API and a stubbed git for the `kit review gate` tests: no network, no
 * clone. Every request is recorded with its headers so a test can see what was sent.
 */
import type { Fetcher } from "./review-gate-github.js";
import type { GitRun } from "./review-gate-importers.js";

export const HEAD = "a".repeat(40);
export const MAIN = "c".repeat(40);

export interface FakeRun {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
}

export const run = (name: string, conclusion: string | null, status = "completed"): FakeRun => ({
  name,
  status,
  conclusion,
  started_at: "2026-11-25T00:00:00Z",
});

export interface FakeFile {
  filename: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
}

export interface FakeGitHub {
  files?: FakeFile[];
  runs?: FakeRun[];
  mainRuns?: FakeRun[];
  /** The rule file's text on the default branch; null for absent (404). */
  rules?: string | null;
  /** A path fragment that answers with this status. */
  fail?: { match: string; status: number };
  /** The head the second read of the pull request returns. */
  headAfter?: string;
}

export interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function page<T>(items: T[], url: URL): T[] {
  const n = Number(url.searchParams.get("page") ?? "1");
  const size = Number(url.searchParams.get("per_page") ?? "30");
  return items.slice((n - 1) * size, n * size);
}

type Answer = [number, unknown];

/** The stubbed endpoints, by exact path. */
function routes(fake: FakeGitHub, url: URL, pullReads: number): Record<string, () => Answer> {
  const sha = pullReads > 1 && fake.headAfter ? fake.headAfter : HEAD;
  return {
    "/repos/o/r/pulls/7": () => [
      200,
      { number: 7, state: "open", draft: false, merged: false, head: { sha } },
    ],
    "/repos/o/r/pulls/7/files": () => [200, page(fake.files ?? [], url)],
    [`/repos/o/r/commits/${HEAD}/check-runs`]: () => [
      200,
      { check_runs: page(fake.runs ?? [], url) },
    ],
    "/repos/o/r": () => [200, { default_branch: "main" }],
    "/repos/o/r/commits/main": () => [200, { sha: MAIN }],
    [`/repos/o/r/commits/${MAIN}/check-runs`]: () => [
      200,
      { check_runs: page(fake.mainRuns ?? [], url) },
    ],
    "/repos/o/r/contents/.github/kit-protected-paths.json": () =>
      fake.rules == null ? [404, {}] : [200, fake.rules],
  };
}

function route(fake: FakeGitHub, url: URL, pullReads: number): Answer {
  if (fake.fail && `${url.pathname}${url.search}`.includes(fake.fail.match))
    return [fake.fail.status, {}];
  const answer = routes(fake, url, pullReads)[url.pathname];
  return answer ? answer() : [404, {}];
}

export function fakeGitHub(fake: FakeGitHub = {}): { fetcher: Fetcher; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let pullReads = 0;
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/repos/o/r/pulls/7") pullReads++;
    calls.push({ url: input, headers: { ...(init?.headers as Record<string, string>) } });
    const [status, body] = route(fake, url, pullReads);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status });
  };
  return { fetcher, calls };
}

/** A git with `src/**` sources at MAIN; anything else fails like a missing commit. */
export function fakeGit(sources: Record<string, string> = {}): GitRun {
  const paths = Object.keys(sources);
  return (args, input) => {
    if (!args.includes(MAIN) && !(input ?? "").includes(MAIN)) throw new Error("bad object");
    if (args[0] === "ls-tree") return Buffer.from(paths.map((p) => `${p}\0`).join(""));
    const parts = paths.map((p) => {
      const body = Buffer.from(sources[p]!, "utf8");
      return Buffer.concat([
        Buffer.from(`${"d".repeat(40)} blob ${body.length}\n`),
        body,
        Buffer.from("\n"),
      ]);
    });
    return Buffer.concat(parts);
  };
}

/** `count` modules that each import src/hub.ts. */
export function hubSources(count: number): Record<string, string> {
  const sources: Record<string, string> = { "src/hub.ts": "export const hub = 1;\n" };
  for (let i = 0; i < count; i++) sources[`src/m${i}.ts`] = 'import { hub } from "./hub.js";\n';
  return sources;
}

#!/usr/bin/env node
/**
 * Deterministic review gate for pull requests (step A). No model, no judgement of the change.
 *
 * When every check on a pull request's head commit has finished, the reviewer GitHub App:
 *   - APPROVES that exact commit when every check passed, no file is in a protected class
 *     (.github/kit-protected-paths.json, read from the default branch), and the change is
 *     under MAX_CHANGED_LINES;
 *   - otherwise comments once on that commit with the reason, and approves nothing.
 * The approval says what it is: the gates passed. It is not a review of the code's intent.
 *
 *   node scripts/agent-review-gate.mjs ready <sha>   → prints ready=true|false (no App token)
 *   node scripts/agent-review-gate.mjs decide <sha>  → approves or comments, as above
 *
 * Reads use GITHUB_TOKEN (the workflow's own, read-only); writes use the App's narrowed token.
 * Every failure to read or decide throws, and a throw approves nothing (fail-closed).
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { installationToken } from "./github-app-token.mjs";
import { runModelReview, withModelVerdict } from "./agent-model-review.mjs";

const API = "https://api.github.com";
export const MAX_CHANGED_LINES = 1500;
const OK = new Set(["success", "skipped", "neutral"]);
const MARK = "<!-- kit-review-gate -->";

/** The newest run per check name: a re-run replaces the earlier result. Pure. */
export function latestChecks(runs) {
  const latest = new Map();
  for (const run of runs) {
    const prev = latest.get(run.name);
    if (!prev || String(run.started_at ?? "") >= String(prev.started_at ?? ""))
      latest.set(run.name, run);
  }
  return [...latest.values()];
}

/** pending while any check runs; failed lists the checks that did not pass. Pure. */
export function checksState(runs) {
  const latest = latestChecks(runs);
  if (latest.length === 0) return { state: "pending", failed: [], total: 0 };
  if (latest.some((r) => r.status !== "completed"))
    return { state: "pending", failed: [], total: latest.length };
  const failed = latest
    .filter((r) => !OK.has(r.conclusion))
    .map((r) => r.name)
    .sort();
  return { state: failed.length ? "failed" : "green", failed, total: latest.length };
}

/** What the App does for one pull request at one commit. Pure. */
export function decide({ sha, checks, protectedPaths, changedLines, fileCount, truncated }) {
  const head = `${MARK}\nkit review gate at \`${sha.slice(0, 12)}\``;
  const reasons = [];
  if (checks.state === "failed") reasons.push(`checks did not pass: ${checks.failed.join(", ")}`);
  if (protectedPaths.length) {
    const classes = [...new Set(protectedPaths.flatMap((p) => p.classes))].sort().join(", ");
    const list = protectedPaths
      .slice(0, 10)
      .map((p) => `\`${p.path}\``)
      .join(", ");
    reasons.push(`touches protected paths (${classes}), which the owner approves: ${list}`);
  }
  if (truncated)
    reasons.push("the file list was truncated by the API, so not every path was classified");
  if (changedLines > MAX_CHANGED_LINES)
    reasons.push(
      `${changedLines} changed lines, over the ${MAX_CHANGED_LINES}-line limit for a gate-only approval`,
    );
  if (reasons.length) {
    return { event: "COMMENT", body: `${head}: **not approved**.\n\n- ${reasons.join("\n- ")}` };
  }
  return {
    event: "APPROVE",
    body:
      `${head}: **gates passed**. All ${checks.total} checks passed on this commit, no file is in a ` +
      `protected class, ${fileCount} files and ${changedLines} lines changed. This approval is ` +
      "deterministic; it does not judge what the change is for.",
  };
}

async function get(path, token, accept = "application/vnd.github+json") {
  const response = await fetch(`${API}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

async function getText(path, token) {
  const response = await fetch(`${API}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/vnd.github.diff",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GET ${path} (diff): HTTP ${response.status}`);
  return response.text();
}

/**
 * The pull request is still open and its head is still the commit that was judged. The files, the
 * diff and the model review are read at the head of that moment, not at `sha`, so a push in
 * between would give the decision for one commit on the content of another. Any read failure
 * counts as "not the same", so a failure never approves.
 */
export async function headIsStill(repo, number, sha, token, read = get) {
  try {
    const pull = await read(`/repos/${repo}/pulls/${number}`, token);
    return pull.state === "open" && pull.head?.sha === sha;
  } catch {
    return false;
  }
}

async function paged(path, token, key, max = 30) {
  const all = [];
  for (let page = 1; page <= max; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await get(`${path}${sep}per_page=100&page=${page}`, token);
    const items = key ? body[key] : body;
    all.push(...items);
    if (items.length < 100) return { items: all, truncated: false };
  }
  return { items: all, truncated: true };
}

function sha40(value) {
  if (!/^[0-9a-f]{40}$/.test(String(value))) throw new Error("usage: <ready|decide> <40-hex sha>");
  return value;
}

async function openPullsAt(repo, sha, token) {
  const pulls = await get(`/repos/${repo}/commits/${sha}/pulls`, token);
  return pulls.filter((p) => p.state === "open" && !p.draft && p.head?.sha === sha);
}

async function ready(sha) {
  const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = process.env;
  const pulls = await openPullsAt(repo, sha40(sha), token);
  const { items } = await paged(`/repos/${repo}/commits/${sha}/check-runs`, token, "check_runs");
  const isReady = pulls.length > 0 && checksState(items).state !== "pending";
  console.log(`open pull requests at ${sha.slice(0, 12)}: ${pulls.length}; ready=${isReady}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${isReady}\n`);
}

/** Identifies one deterministic decision; the model's wording varies, so it is not part of it. */
export function decisionKey(decision) {
  const digest = createHash("sha256").update(`${decision.event}\n${decision.body}`).digest("hex");
  return `<!-- kit-review-key:${digest.slice(0, 16)} -->`;
}

/** This decision was already posted at this commit (a changed outcome gets a new key). */
async function alreadyPosted(repo, pr, sha, key, token) {
  const { items } = await paged(`/repos/${repo}/pulls/${pr}/reviews`, token);
  return items.some((r) => r.commit_id === sha && String(r.body ?? "").includes(key));
}

/** Step B, only on what step A would approve. Any failure is a refusal, never an approval. */
async function withModel(repo, pull, decision, token) {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (decision.event !== "APPROVE" || !oauth) return decision;
  try {
    const diff = await getText(`/repos/${repo}/pulls/${pull.number}`, token);
    const model = process.env.REVIEWER_MODEL || undefined;
    const review = runModelReview({
      title: pull.title,
      body: pull.body,
      diff,
      token: oauth,
      model,
    });
    return withModelVerdict(decision, review);
  } catch (err) {
    const head = decision.body.split(":")[0];
    return {
      event: "COMMENT",
      body: `${head}: **not approved**. The gates passed, but the model review did not complete: ${err.message}.`,
    };
  }
}

async function post(repo, pr, sha, decision, appToken) {
  const response = await fetch(`${API}/repos/${repo}/pulls/${pr}/reviews`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commit_id: sha, event: decision.event, body: decision.body }),
  });
  if (!response.ok) throw new Error(`POST review on #${pr}: HTTP ${response.status}`);
}

async function decideAll(sha) {
  const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = process.env;
  const { loadProtectedPathRules, classifyProtectedPaths } = await import(
    pathToFileURL(`${process.cwd()}/dist/review-protected-paths.js`).href
  );
  const rules = loadProtectedPathRules(process.cwd());
  const runs = (await paged(`/repos/${repo}/commits/${sha40(sha)}/check-runs`, token, "check_runs"))
    .items;
  const checks = checksState(runs);
  if (checks.state === "pending") return console.log("checks still running; nothing to decide");
  let appToken = null;
  for (const pull of await openPullsAt(repo, sha, token)) {
    const files = await paged(`/repos/${repo}/pulls/${pull.number}/files`, token);
    if (!(await headIsStill(repo, pull.number, sha, token))) {
      console.log(
        `#${pull.number}: head moved while reading the files; the new push is judged on its own run`,
      );
      continue;
    }
    const paths = files.items.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
    const decision = decide({
      sha,
      checks,
      protectedPaths: classifyProtectedPaths(paths, rules),
      changedLines: files.items.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0),
      fileCount: files.items.length,
      truncated: files.truncated,
    });
    const key = decisionKey(decision);
    if (await alreadyPosted(repo, pull.number, sha, key, token)) {
      console.log(`#${pull.number}: ${decision.event} already decided at this commit`);
      continue;
    }
    const final = await withModel(repo, pull, decision, token);
    if (!(await headIsStill(repo, pull.number, sha, token))) {
      console.log(
        `#${pull.number}: head moved during the review; nothing posted for ${sha.slice(0, 12)}`,
      );
      continue;
    }
    appToken ??= await installationToken();
    await post(repo, pull.number, sha, { ...final, body: `${final.body}\n${key}` }, appToken);
    console.log(`#${pull.number}: ${final.event}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [mode, sha] = process.argv.slice(2);
  const run =
    mode === "ready"
      ? ready(sha)
      : mode === "decide"
        ? decideAll(sha)
        : Promise.reject(new Error("usage: <ready|decide> <sha>"));
  run.catch((err) => {
    console.error(`agent-review-gate: ${err.message}`);
    process.exit(1);
  });
}

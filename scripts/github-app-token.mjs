#!/usr/bin/env node
/**
 * Mint a short-lived GitHub App installation token, narrowed to this repository and to the
 * permissions a reviewer needs, and use it inside this process only. Stdlib only (node:crypto).
 *
 * The App's private key never leaves this process, and the token is never printed. The key can
 * mint tokens for everything the installation was granted; the token asks for less: one
 * repository, pull requests write (to review), contents read.
 *
 *   node scripts/github-app-token.mjs probe <pr>
 *
 * `probe` posts a COMMENT review (never an approval) on the pull request as the App and prints
 * the login GitHub recorded for it, so the reviewer identity can be checked before any
 * approval is wired to it.
 *
 * Env: REVIEWER_APP_ID, REVIEWER_APP_PRIVATE_KEY (PEM), GITHUB_REPOSITORY (owner/name).
 */
import { createSign } from "node:crypto";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
export const REVIEWER_PERMISSIONS = Object.freeze({ pull_requests: "write", contents: "read" });

const b64url = (value) => Buffer.from(value).toString("base64url");

/** RS256 JWT that authenticates as the App for at most ten minutes. */
export function appJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!/^\d+$/.test(String(appId)) && !/^Iv[0-9A-Za-z.]+$/.test(String(appId)))
    throw new Error("REVIEWER_APP_ID must be a numeric App ID or a client ID");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat 60 s in the past absorbs clock drift; GitHub rejects exp more than 10 min ahead.
  const payload = b64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem, "base64url")}`;
}

/** The token request body: one repository, the reviewer's permissions, nothing else. */
export function tokenRequest(repository) {
  const [owner, name, extra] = String(repository).split("/");
  if (!owner || !name || extra !== undefined)
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  return { repositories: [name], permissions: { ...REVIEWER_PERMISSIONS } };
}

async function api(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status}`);
  return body;
}

export async function installationToken(env = process.env) {
  const key = (env.REVIEWER_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  if (!env.REVIEWER_APP_ID || !key.includes("PRIVATE KEY"))
    throw new Error("REVIEWER_APP_ID and REVIEWER_APP_PRIVATE_KEY are required");
  const request = tokenRequest(env.GITHUB_REPOSITORY);
  const jwt = appJwt(env.REVIEWER_APP_ID, key);
  const installation = await api(`/repos/${env.GITHUB_REPOSITORY}/installation`, jwt);
  const minted = await api(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify(request),
  });
  return minted.token;
}

async function probe(pr) {
  if (!/^\d+$/.test(String(pr))) throw new Error("usage: github-app-token.mjs probe <pr number>");
  const token = await installationToken();
  const repo = process.env.GITHUB_REPOSITORY;
  const review = await api(`/repos/${repo}/pulls/${pr}/reviews`, token, {
    method: "POST",
    body: JSON.stringify({
      event: "COMMENT",
      body: "Reviewer identity probe: this review was posted by the reviewer App with a token narrowed to this repository. It approves nothing.",
    }),
  });
  console.log(`review ${review.id} posted as ${review.user?.login} (type ${review.user?.type})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [mode, arg] = process.argv.slice(2);
  const run = mode === "probe" ? probe(arg) : Promise.reject(new Error("usage: probe <pr>"));
  run.catch((err) => {
    console.error(`github-app-token: ${err.message}`);
    process.exit(1);
  });
}

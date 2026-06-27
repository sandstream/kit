/**
 * GitLab CI / Bitbucket Pipelines hardening — static YAML lint (#145).
 *
 * The git-host parity to `gha-audit` (which is GitHub-Actions-only). Deterministic,
 * local-first, no network, no YAML dep (line-scan). Flags the highest-signal
 * CI supply-chain footguns that apply to both `.gitlab-ci.yml` and
 * `bitbucket-pipelines.yml`:
 *   - unpinned container images: `image: node:latest` / `image: node` (mutable
 *     tag → non-reproducible build, the image can change under you). A digest pin
 *     (`@sha256:…`) or a concrete version tag is fine.
 *   - remote `include:` (GitLab): pulling CI config from an external URL — the
 *     remote can change and inject steps (supply-chain trust).
 *   - pipe-to-shell in a `script:` step: `curl … | sh` (download-and-run).
 *
 * Pure analyzers (text → findings); `runCiAudit` reads the two CI files.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

const IMAGE_RULE = {
  id: "CWE-1104",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/1104.html",
  title: "Use of Unmaintained Third Party Components",
};
const REMOTE_INCLUDE_RULE = {
  id: "OWASP-A08",
  source: "owasp" as const,
  ref: "https://owasp.org/Top10/A08_2021-Software_and_Data_Integrity_Failures/",
  title: "Software and Data Integrity Failures",
};
const PIPE_TO_SHELL_RULE = {
  id: "CWE-494",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/494.html",
  title: "Download of Code Without Integrity Check",
};

/** The image ref's tag, or "" if untagged. Handles registry:port/name:tag. */
function imageTag(ref: string): string {
  const lastSegment = ref.split("/").pop() ?? ref; // drop registry/host[:port]/path
  const colon = lastSegment.lastIndexOf(":");
  return colon === -1 ? "" : lastSegment.slice(colon + 1);
}

/** A digest-pinned image (`name@sha256:…`) is reproducible. */
function isDigestPinned(ref: string): boolean {
  return /@sha256:[0-9a-f]{64}/i.test(ref);
}

/** Lint one CI YAML file's text. Pure. */
export function auditCiYaml(content: string, file: string): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];
  const seenImages = new Set<string>();

  // image: <ref>  and  name: <ref>  (services / Bitbucket image.name). Capture the
  // key so a bare `name:` label (a Bitbucket step name, a job/stage name) isn't
  // mistaken for an image — only treat a `name:` value as an image when it is
  // image-shaped (has a registry path `/`, a tag `:`, or a digest `@`). `image:`
  // is unambiguous, so an untagged `image: node` is still flagged.
  const imageRe = /(?:^|\n)\s*(image|[-\s]?name):\s*['"]?([A-Za-z0-9][\w./:@-]+)/g;
  for (const m of content.matchAll(imageRe)) {
    const isNameKey = m[1].trim().endsWith("name");
    const ref = m[2];
    if (isNameKey && !/[:/@]/.test(ref)) continue; // bare `name:` label, not an image
    if (isDigestPinned(ref)) continue;
    const tag = imageTag(ref);
    if (tag && tag !== "latest") continue; // a concrete version tag is acceptable
    if (seenImages.has(ref)) continue;
    seenImages.add(ref);
    out.push({
      category: "supply-chain",
      name: `unpinned image ${ref} (${file})`,
      status: "warn",
      detail: `'${ref}' uses ${tag === "latest" ? "the mutable :latest tag" : "no tag"} — pin a concrete version or @sha256 digest for reproducible, tamper-evident builds`,
      severity: "medium",
      suggestion: `pin ${ref} to a version tag or a @sha256:… digest`,
      rule: IMAGE_RULE,
    });
  }

  // GitLab: include a remote CI config from an external URL.
  const remoteIncludeRe = /remote:\s*['"]?(https?:\/\/[^\s'"]+)/gi;
  for (const m of content.matchAll(remoteIncludeRe)) {
    out.push({
      category: "exposure",
      name: `remote CI include (${file})`,
      status: "warn",
      detail: `includes CI config from ${m[1]} — a remote include can change and inject pipeline steps`,
      severity: "medium",
      suggestion: "vendor the included config, or pin the remote to an immutable ref",
      rule: REMOTE_INCLUDE_RULE,
    });
  }

  // Pipe-to-shell in a script step.
  if (/(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i.test(content)) {
    out.push({
      category: "supply-chain",
      name: `pipe-to-shell in ${file}`,
      status: "warn",
      detail: "a script pipes a download straight into a shell (curl … | sh) — no integrity check",
      severity: "medium",
      suggestion: "download to a file, verify a checksum/signature, then execute",
      rule: PIPE_TO_SHELL_RULE,
    });
  }

  return out;
}

/** Audit GitLab CI + Bitbucket Pipelines files under `cwd`. Read-only. */
export function runCiAudit(cwd: string): SecurityCheckResult[] {
  const files = [".gitlab-ci.yml", "bitbucket-pipelines.yml"];
  const out: SecurityCheckResult[] = [];
  let scanned = 0;
  for (const f of files) {
    const path = resolve(cwd, f);
    if (!existsSync(path)) continue;
    scanned++;
    try {
      out.push(...auditCiYaml(readFileSync(path, "utf8"), f));
    } catch {
      // unreadable → skip (fail-open per file)
    }
  }
  if (scanned === 0) {
    return [
      {
        category: "supply-chain",
        name: "ci-audit",
        status: "skip",
        detail: "no .gitlab-ci.yml or bitbucket-pipelines.yml",
      },
    ];
  }
  if (out.length === 0) {
    out.push({
      category: "supply-chain",
      name: "ci-audit",
      status: "pass",
      detail: `${scanned} CI file(s): images pinned, no remote include, no pipe-to-shell`,
    });
  }
  return out;
}

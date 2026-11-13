/**
 * Inspect two commit snapshots after a pull or merge.
 * Compare dependency specifications in all tracked package.json files, including nested manifests.
 * Report root ignore and policy changes, agent files, and secrets in changed head blobs.
 * Unreadable input makes inspection incomplete. Only a successful tree read can establish that a file is absent.
 * This audit does not resolve lockfile dependencies, assess package safety, or enforce install restrictions.
 */

import { isUtf8 } from "node:buffer";
import { findSecrets, redactSecrets, type SecretFinding } from "./utils/redactSecrets.js";
import { exec } from "./utils/exec.js";
import { agentFilesIn } from "./pull-agent-files.js";

export interface PullAuditReport {
  baseRef: string;
  headRef: string;
  coverage: PullAuditCoverage;
  errors: PullAuditError[];
  dependencyChanges: DependencyChange[];
  newDependencies: string[];
  removedDependencies: string[];
  removedGitignoreEntries: string[];
  /** Sensitivity is determined from original entries before report text is redacted. */
  gitignoreRemovals: { entry: string; sensitive: boolean }[];
  newGitignoreEntries: string[];
  plaintextHits: { file: string; findings: SecretFinding[] }[];
  allowlistChanged: boolean;
  policyChanged: boolean;
  kitTomlChanged: boolean;
  changedFiles: string[];
  /** Deleted paths have no head content to scan. Relevant manifest and policy removals still apply. */
  removedFiles: string[];
  /** Added or changed files an agent or editor executes or obeys (hooks, MCP, tasks, instructions). */
  agentFiles: { file: string; kind: string }[];
}

export interface PullAuditCoverage {
  status: "complete" | "incomplete";
  fileScope: "known" | "unknown";
  /** Completeness applies only to this scope, not package safety or install enforcement. */
  scope: "tracked-manifests-and-changed-head-blobs";
  /** Manifest paths in either tree. Errors identify any that could not be inspected. */
  manifestFiles: string[];
  lockfileDependencies: "not-inspected";
}

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export interface DependencyChange {
  file: string;
  section: DependencySection;
  name: string;
  kind: "added" | "removed" | "changed";
  /** Specifications can be masked. Comparison happens before redaction. */
  before: string | null;
  after: string | null;
}

export interface PullAuditError {
  code:
    | "ref-unavailable"
    | "git-read-failed"
    | "invalid-path-encoding"
    | "invalid-manifest"
    | "unsupported-entry";
  operation: "resolve-ref" | "list-tree" | "read-blob" | "parse-manifest";
  ref: string;
  file?: string;
  message: string;
}

async function resolveCommit(
  ref: string,
  cwd: string,
  report: PullAuditReport,
): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      {
        cwd,
        timeout: 5_000,
      },
    );
    return stdout.trim();
  } catch {
    report.coverage.status = "incomplete";
    report.errors.push({
      code: "ref-unavailable",
      operation: "resolve-ref",
      ref,
      message: "Cannot resolve the requested commit. Check the ref and local Git repository.",
    });
    return null;
  }
}

type PackageJson = Partial<Record<DependencySection, Record<string, string>>>;

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
}

type FileRead =
  { status: "read"; content: string } | { status: "absent" } | { status: "unreadable" };

interface Snapshot {
  ref: string;
  files: Map<string, TreeEntry>;
  reads: Map<string, FileRead>;
}

function inspectionError(report: PullAuditReport, error: PullAuditError): void {
  report.coverage.status = "incomplete";
  report.errors.push(error);
}

async function snapshot(
  ref: string,
  cwd: string,
  report: PullAuditReport,
): Promise<Snapshot | null> {
  try {
    const { stdout } = await exec("git", ["ls-tree", "-r", "-z", "--full-tree", ref], {
      cwd,
      timeout: 10_000,
      encoding: "buffer",
    });
    if (!isUtf8(stdout)) {
      inspectionError(report, {
        code: "invalid-path-encoding",
        operation: "list-tree",
        ref,
        message:
          "Git tree paths contain invalid UTF-8. File identity cannot be preserved; file scope is unknown.",
      });
      return null;
    }
    const files = new Map<string, TreeEntry>();
    for (const record of stdout.toString("utf8").split("\0").filter(Boolean)) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error("Invalid Git tree record");
      const [, mode, type, oid, path] = match;
      files.set(path, { mode, type, oid });
    }
    return { ref, files, reads: new Map() };
  } catch {
    inspectionError(report, {
      code: "git-read-failed",
      operation: "list-tree",
      ref,
      message: "Cannot enumerate the commit tree. File scope is unknown.",
    });
    return null;
  }
}

async function readFile(
  tree: Snapshot,
  file: string,
  cwd: string,
  report: PullAuditReport,
): Promise<FileRead> {
  const cached = tree.reads.get(file);
  if (cached) return cached;
  const entry = tree.files.get(file);
  if (!entry) return { status: "absent" };
  let result: FileRead = { status: "unreadable" };
  if (entry.type !== "blob") {
    inspectionError(report, {
      code: "unsupported-entry",
      operation: "read-blob",
      ref: tree.ref,
      file,
      message: "Cannot inspect this entry as a Git blob.",
    });
  } else {
    try {
      const { stdout } = await exec("git", ["cat-file", "blob", entry.oid], {
        cwd,
        timeout: 5_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      result = { status: "read", content: stdout };
    } catch {
      inspectionError(report, {
        code: "git-read-failed",
        operation: "read-blob",
        ref: tree.ref,
        file,
        message: "Cannot read the tracked blob. Its content is unknown, not absent.",
      });
    }
  }
  // Cache failures to avoid duplicate errors without retaining all scanned blob contents.
  if (result.status === "unreadable") tree.reads.set(file, result);
  return result;
}

function fileChanged(file: string, before: Snapshot, after: Snapshot): boolean {
  const b = before.files.get(file);
  const a = after.files.get(file);
  return b?.oid !== a?.oid || b?.mode !== a?.mode;
}

function diffDeps(
  file: string,
  before: PackageJson,
  after: PackageJson,
  report: PullAuditReport,
): void {
  const beforeAll = new Set(
    DEPENDENCY_SECTIONS.flatMap((section) => Object.keys(before[section] ?? {})),
  );
  const afterAll = new Set(
    DEPENDENCY_SECTIONS.flatMap((section) => Object.keys(after[section] ?? {})),
  );
  report.newDependencies.push(...[...afterAll].filter((name) => !beforeAll.has(name)));
  report.removedDependencies.push(...[...beforeAll].filter((name) => !afterAll.has(name)));
  for (const section of DEPENDENCY_SECTIONS) {
    const b = new Map(Object.entries(before[section] ?? {}));
    const a = new Map(Object.entries(after[section] ?? {}));
    for (const name of [...new Set([...b.keys(), ...a.keys()])].sort()) {
      const oldSpec = b.get(name) ?? null;
      const newSpec = a.get(name) ?? null;
      if (oldSpec === newSpec) continue;
      report.dependencyChanges.push({
        file,
        section,
        name,
        kind: oldSpec === null ? "added" : newSpec === null ? "removed" : "changed",
        before: oldSpec,
        after: newSpec,
      });
    }
  }
}

function diffLines(
  before: string | null,
  after: string | null,
): {
  added: string[];
  removed: string[];
} {
  const cleanup = (t: string | null): Set<string> => {
    if (!t) return new Set();
    return new Set(
      t
        .split("\n")
        .map((l) => {
          const i = l.indexOf("#");
          const stripped = i >= 0 ? l.slice(0, i) : l;
          return stripped.trim();
        })
        .filter((l) => l.length > 0),
    );
  };
  const b = cleanup(before);
  const a = cleanup(after);
  return {
    added: [...a].filter((line) => !b.has(line)),
    removed: [...b].filter((line) => !a.has(line)),
  };
}

/**
 * The base of the range a pull brought in, when the caller named none.
 *
 * `HEAD~1` alone is the last commit, and a pull that fast-forwards several commits brought in all
 * of them: a dependency added in any but the last was never audited, and the hook said green
 * (kit-research `thomas-wolf-future-of-software-vs-kit`). `git pull` and `git merge` record the
 * commit they started from in `ORIG_HEAD`, so `ORIG_HEAD..HEAD` is what the pull brought in.
 *
 * `ORIG_HEAD` is used only when it is a strict ancestor of `HEAD`. Other commands set it too
 * (reset, rebase), and then it can point anywhere; the fallback is `HEAD~1`, and `fallback` says so.
 * A stale ancestor `ORIG_HEAD` over-audits (it also covers later commits of your own), which errs
 * toward showing more, never less.
 */
export async function defaultPullBase(
  cwd: string = process.cwd(),
): Promise<{ base: string; fallback: boolean }> {
  const rev = async (ref: string): Promise<string | null> => {
    try {
      const { stdout } = await exec(
        "git",
        ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
        {
          cwd,
          timeout: 5_000,
        },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const [orig, head] = await Promise.all([rev("ORIG_HEAD"), rev("HEAD")]);
  if (orig && head && orig !== head) {
    try {
      await exec("git", ["merge-base", "--is-ancestor", orig, head], { cwd, timeout: 5_000 });
      return { base: "ORIG_HEAD", fallback: false };
    } catch {
      /* not an ancestor: fall through */
    }
  }
  return { base: "HEAD~1", fallback: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readManifest(
  tree: Snapshot,
  file: string,
  cwd: string,
  report: PullAuditReport,
): Promise<PackageJson | undefined> {
  const entry = tree.files.get(file);
  if (entry && entry.mode !== "100644" && entry.mode !== "100755") {
    inspectionError(report, {
      code: "unsupported-entry",
      operation: "parse-manifest",
      ref: tree.ref,
      file,
      message: "The tracked manifest is not a regular file. Its dependencies cannot be inspected.",
    });
    return undefined;
  }
  const read = await readFile(tree, file, cwd, report);
  if (read.status === "unreadable") return undefined;
  if (read.status === "absent") return {};
  try {
    // npm accepts a leading UTF-8 BOM. Remove only that marker before JSON validation.
    const value: unknown = JSON.parse(read.content.replace(/^\uFEFF/, ""));
    if (!isObject(value)) throw new Error("Expected a manifest object");
    for (const section of DEPENDENCY_SECTIONS) {
      if (!Object.hasOwn(value, section)) continue;
      const dependencies = value[section];
      if (
        !isObject(dependencies) ||
        Object.values(dependencies).some((spec) => typeof spec !== "string")
      ) {
        throw new Error("Expected a dependency map with string specifications");
      }
    }
    return value as PackageJson;
  } catch {
    inspectionError(report, {
      code: "invalid-manifest",
      operation: "parse-manifest",
      ref: tree.ref,
      file,
      message:
        "Invalid manifest. Expected a JSON object with dependency maps containing string specifications.",
    });
    return undefined;
  }
}

/** Compare dependencies only when both manifests can be inspected. */
async function dependencyChanges(
  base: Snapshot,
  head: Snapshot,
  cwd: string,
  report: PullAuditReport,
): Promise<void> {
  report.coverage.manifestFiles = [...new Set([...base.files.keys(), ...head.files.keys()])]
    .filter((file) => file === "package.json" || file.endsWith("/package.json"))
    .sort();
  for (const file of report.coverage.manifestFiles) {
    const before = await readManifest(base, file, cwd, report);
    const after = await readManifest(head, file, cwd, report);
    if (before && after) diffDeps(file, before, after, report);
  }
  report.newDependencies = [...new Set(report.newDependencies)].sort();
  report.removedDependencies = [...new Set(report.removedDependencies)].sort();
}

/** Plaintext secrets in the head version of each changed file. */
async function plaintextHitsIn(
  changed: string[],
  head: Snapshot,
  cwd: string,
  report: PullAuditReport,
): Promise<PullAuditReport["plaintextHits"]> {
  const hits: PullAuditReport["plaintextHits"] = [];
  for (const path of changed) {
    const content = await readFile(head, path, cwd, report);
    if (content.status !== "read") continue;
    const findings = findSecrets(content.content);
    if (findings.length > 0) hits.push({ file: path, findings });
  }
  return hits;
}

/** Redact string values before JSON encoding so escaped quotes cannot hide credentials. */
function redactReport(report: PullAuditReport): PullAuditReport {
  return JSON.parse(
    JSON.stringify(report, (_key, value: unknown) =>
      typeof value === "string" ? redactSecrets(value) : value,
    ),
  ) as PullAuditReport;
}

export async function auditPull(
  cwd: string = process.cwd(),
  baseRef: string = "HEAD~1",
  headRef: string = "HEAD",
): Promise<PullAuditReport> {
  const report: PullAuditReport = {
    baseRef,
    headRef,
    coverage: {
      status: "complete",
      fileScope: "unknown",
      scope: "tracked-manifests-and-changed-head-blobs",
      manifestFiles: [],
      lockfileDependencies: "not-inspected",
    },
    errors: [],
    dependencyChanges: [],
    newDependencies: [],
    removedDependencies: [],
    removedGitignoreEntries: [],
    gitignoreRemovals: [],
    newGitignoreEntries: [],
    plaintextHits: [],
    allowlistChanged: false,
    policyChanged: false,
    kitTomlChanged: false,
    changedFiles: [],
    removedFiles: [],
    agentFiles: [],
  };

  const base = await resolveCommit(baseRef, cwd, report);
  const head = await resolveCommit(headRef, cwd, report);
  if (!base || !head) return redactReport(report);
  const before = await snapshot(base, cwd, report);
  const after = await snapshot(head, cwd, report);
  if (!before || !after) return redactReport(report);
  report.coverage.fileScope = "known";

  await dependencyChanges(before, after, cwd, report);

  const beforeIgnore = await readFile(before, ".gitignore", cwd, report);
  const afterIgnore = await readFile(after, ".gitignore", cwd, report);
  if (beforeIgnore.status !== "unreadable" && afterIgnore.status !== "unreadable") {
    const giDiff = diffLines(
      beforeIgnore.status === "read" ? beforeIgnore.content : null,
      afterIgnore.status === "read" ? afterIgnore.content : null,
    );
    report.newGitignoreEntries = giDiff.added;
    report.removedGitignoreEntries = giDiff.removed;
    report.gitignoreRemovals = giDiff.removed.map((entry) => ({
      entry,
      sensitive: /\.env|\.pem|\.key|id_rsa/.test(entry),
    }));
  }

  report.changedFiles = [...after.files.keys()].filter((file) => fileChanged(file, before, after));
  report.removedFiles = [...before.files.keys()].filter((file) => !after.files.has(file));
  report.agentFiles = agentFilesIn(report.changedFiles);
  report.plaintextHits = await plaintextHitsIn(report.changedFiles, after, cwd, report);

  report.allowlistChanged = fileChanged(".kit-allowlist.json", before, after);
  report.policyChanged = fileChanged(".kit-policy.json", before, after);
  report.kitTomlChanged = fileChanged(".kit.toml", before, after);

  return redactReport(report);
}

export function reportSeverity(report: PullAuditReport): "ok" | "warn" | "fail" {
  if (report.coverage.status === "incomplete" || report.errors.length > 0) return "fail";
  if (report.plaintextHits.length > 0) return "fail";
  if (report.gitignoreRemovals.some((removal) => removal.sensitive)) {
    return "fail";
  }
  if (
    report.newDependencies.length > 0 ||
    report.dependencyChanges.some((change) => change.kind !== "removed") ||
    report.allowlistChanged ||
    report.policyChanged ||
    report.agentFiles.length > 0
  ) {
    return "warn";
  }
  return "ok";
}

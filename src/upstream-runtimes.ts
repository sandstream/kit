/**
 * Runtime exposure for `kit upstream`: is the Node, PHP or Python interpreter this project uses
 * behind a patch release, and is a newer patch a security release? Sources are the GitHub
 * releases of nodejs/node and php/php-src, and the tags of python/cpython (it publishes no
 * releases, so its tags carry no notes). Pure decision functions plus a reader for the declared
 * version and one for the installed one. A version file in the repository is untrusted input.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { isNewer } from "./update-check.js";
import { readRegularFileIfPresent } from "./upstream-safe-read.js";
import { stripControl } from "./upstream-sources.js";
import type { ReleaseInfo } from "./upstream-sources.js";

const execFileAsync = promisify(execFile);

export type RuntimeId = "node" | "php" | "python";

export interface RuntimeSpec {
  id: RuntimeId;
  label: string;
  /** Binaries to try, in order. */
  bins: readonly string[];
  github: string;
  /** What precedes the version in a tag: `v` for node, `php-` for php. */
  tagPrefix: string;
  /** Read GitHub releases (with notes) or only tags. */
  source: "releases" | "tags";
  /** Where the vendor's end-of-life dates are read from, when a GitHub-hosted source exists. */
  schedule?: { repo: string; path: string };
  /** Which part of the installed version names its release line. */
  line: "major" | "minor";
  /** Releases to read; wide enough to reach older supported lines. */
  window: number;
}

export const RUNTIME_SPECS: readonly RuntimeSpec[] = [
  {
    id: "node",
    label: "Node.js",
    bins: ["node"],
    github: "nodejs/node",
    tagPrefix: "v",
    source: "releases",
    line: "major",
    window: 40,
    schedule: { repo: "nodejs/Release", path: "schedule.json" },
  },
  {
    id: "php",
    label: "PHP",
    bins: ["php"],
    github: "php/php-src",
    tagPrefix: "php-",
    source: "releases",
    line: "minor",
    window: 40,
  },
  {
    id: "python",
    label: "Python",
    bins: ["python3", "python"],
    github: "python/cpython",
    tagPrefix: "v",
    source: "tags",
    line: "minor",
    window: 0,
  },
];

export type RuntimeVerdict =
  | "current"
  | "end of life"
  | "patch available"
  | "security release available"
  | "unknown"
  | "skipped";

export interface RuntimeAssessment {
  verdict: Exclude<RuntimeVerdict, "skipped">;
  /** Newest patch on the installed release line, when one was found. */
  latest: string | null;
  /** Lines of the newer release notes that mention a security release or a CVE. */
  evidence: string[];
  detail?: string;
  /** The date the installed line stops getting fixes, when the vendor's schedule says so. */
  supportedUntil?: string;
}

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const SECURITY = /security release|CVE-\d{4}-\d{4,}|vulnerabilit/i;
const MAX_EVIDENCE = 3;
const MAX_LINE = 200;
const MAX_DECLARED = 40;

export function parseVersionOutput(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

function versionOfTag(spec: RuntimeSpec, tag: string): string | null {
  if (!tag.startsWith(spec.tagPrefix)) return null;
  const bare = tag.slice(spec.tagPrefix.length);
  return PLAIN_VERSION.test(bare) ? bare : null;
}

function lineOf(spec: RuntimeSpec, version: string): string {
  const [major, minor] = version.split(".");
  return spec.line === "major" ? major : `${major}.${minor}`;
}

function newest(versions: readonly string[]): string | null {
  return versions.reduce<string | null>(
    (best, v) => (best === null || isNewer(v, best) ? v : best),
    null,
  );
}

function evidenceLines(releases: readonly { tag: string; body: string }[]): string[] {
  const lines: string[] = [];
  for (const r of releases) {
    for (const raw of stripControl(r.body, true).split("\n")) {
      if (lines.length >= MAX_EVIDENCE) return lines;
      if (SECURITY.test(raw)) lines.push(`${r.tag}: ${raw.trim()}`.slice(0, MAX_LINE));
    }
  }
  return lines;
}

export interface LineEnd {
  ended: boolean;
  /** The date the line stops getting fixes, as the vendor writes it. */
  end: string;
}

/**
 * Whether the installed release line is past its end, from the vendor's own schedule. Only the Node
 * schedule is read, because it is the only one hosted on GitHub; PHP and Python return null (nothing
 * is claimed). A line the schedule does not list or date, or a schedule that is not readable, is null,
 * which the caller reports as unverified and never as supported.
 */
/** The `end` date the Node schedule lists for a major, or null when it is absent or not a date. */
function scheduledEnd(scheduleText: string, major: string): string | null {
  let schedule: unknown;
  try {
    schedule = JSON.parse(scheduleText);
  } catch {
    return null;
  }
  if (typeof schedule !== "object" || schedule === null || Array.isArray(schedule)) return null;
  const entry = (schedule as Record<string, unknown>)[`v${major}`];
  const end = typeof entry === "object" && entry !== null ? (entry as { end?: unknown }).end : null;
  return typeof end === "string" && !Number.isNaN(Date.parse(end)) ? end : null;
}

export function lineEndOfLife(
  spec: RuntimeSpec,
  installed: string,
  scheduleText: string,
  nowMs: number,
): LineEnd | null {
  if (spec.id !== "node") return null;
  const end = scheduledEnd(scheduleText, installed.split(".")[0]);
  return end === null
    ? null
    : { ended: Date.parse(end) < nowMs, end: stripControl(end).slice(0, 10) };
}

export function decideRuntime(
  spec: RuntimeSpec,
  installed: string | null,
  releases: readonly ReleaseInfo[],
  tags: readonly string[],
  lineEnd: LineEnd | null = null,
): RuntimeAssessment {
  if (installed === null) {
    return {
      verdict: "unknown",
      latest: null,
      evidence: [],
      detail: `${spec.bins[0]} not found on PATH`,
    };
  }
  const line = lineOf(spec, installed);
  if (lineEnd?.ended) {
    return {
      verdict: "end of life",
      latest: null,
      evidence: [`the ${spec.label} ${line} line reached end of life on ${lineEnd.end}`],
    };
  }
  const candidates = [
    ...releases
      .filter((r) => !r.prerelease)
      .map((r) => ({ version: versionOfTag(spec, r.tag), tag: r.tag, body: r.body })),
    ...tags.map((tag) => ({ version: versionOfTag(spec, tag), tag, body: "" })),
  ].filter(
    (c): c is { version: string; tag: string; body: string } =>
      c.version !== null && lineOf(spec, c.version) === line,
  );

  const latest = newest(candidates.map((c) => c.version));
  if (latest === null) {
    return {
      verdict: "unknown",
      latest: null,
      evidence: [],
      detail: `no release of the ${line} line in the fetched window (older than the window, or end of life)`,
    };
  }
  if (!isNewer(latest, installed)) return { verdict: "current", latest, evidence: [] };

  const newer = candidates.filter((c) => isNewer(c.version, installed));
  const evidence = evidenceLines(newer.filter((c) => SECURITY.test(c.body)));
  if (evidence.length > 0) return { verdict: "security release available", latest, evidence };
  const noNotes =
    spec.source === "tags"
      ? "tags carry no release notes, so the security status of newer patches is unknown"
      : undefined;
  return {
    verdict: "patch available",
    latest,
    evidence: [],
    ...(noNotes ? { detail: noNotes } : {}),
  };
}

export interface DetectedRuntime {
  id: RuntimeId;
  /** What the project declares, or null when it only shows that it uses the runtime. */
  declared: string | null;
  declaredFrom: string | null;
}

function readQuiet(root: string, rel: string): string | null {
  try {
    return readRegularFileIfPresent(join(root, rel));
  } catch {
    return null;
  }
}

function cleanDeclared(raw: string): string | null {
  const first = stripControl(raw.split("\n")[0] ?? "")
    .trim()
    .replace(/^v(?=\d)/, "");
  return first === "" ? null : first.slice(0, MAX_DECLARED);
}

function jsonField(text: string | null, path: readonly string[]): string | null {
  if (text === null) return null;
  try {
    let node: unknown = JSON.parse(text);
    for (const key of path) node = (node as Record<string, unknown> | null)?.[key];
    return typeof node === "string" ? node : null;
  } catch {
    return null;
  }
}

function toolVersions(text: string | null, names: readonly string[]): string | null {
  for (const line of (text ?? "").split("\n")) {
    const [name, version] = line.trim().split(/\s+/);
    if (name && version && names.includes(name)) return version;
  }
  return null;
}

function miseVersion(text: string | null, name: string): string | null {
  if (text === null) return null;
  try {
    const tools = (parseToml(text) as { tools?: Record<string, unknown> }).tools;
    const entry = tools?.[name];
    const value = Array.isArray(entry)
      ? entry[0]
      : entry && typeof entry === "object"
        ? (entry as { version?: unknown }).version
        : entry;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function tomlField(text: string | null, section: string, key: string): string | null {
  if (text === null) return null;
  try {
    const value = ((parseToml(text) as Record<string, Record<string, unknown> | undefined>)[
      section
    ] ?? {})[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Declared-version sources in precedence order: the first one that names a version wins. */
function declaredSources(root: string, id: RuntimeId): { from: string; value: string | null }[] {
  const tools = readQuiet(root, ".tool-versions");
  const mise = readQuiet(root, "mise.toml");
  const first = (rel: string) => readQuiet(root, rel);
  if (id === "node") {
    return [
      { from: ".nvmrc", value: first(".nvmrc") },
      { from: ".node-version", value: first(".node-version") },
      { from: ".tool-versions", value: toolVersions(tools, ["nodejs", "node"]) },
      { from: "mise.toml", value: miseVersion(mise, "node") },
      {
        from: "package.json engines.node",
        value: jsonField(first("package.json"), ["engines", "node"]),
      },
    ];
  }
  if (id === "php") {
    return [
      { from: ".php-version", value: first(".php-version") },
      { from: ".tool-versions", value: toolVersions(tools, ["php"]) },
      { from: "mise.toml", value: miseVersion(mise, "php") },
      {
        from: "composer.json require.php",
        value: jsonField(first("composer.json"), ["require", "php"]),
      },
    ];
  }
  return [
    { from: ".python-version", value: first(".python-version") },
    { from: ".tool-versions", value: toolVersions(tools, ["python"]) },
    { from: "mise.toml", value: miseVersion(mise, "python") },
    {
      from: "pyproject.toml requires-python",
      value: tomlField(first("pyproject.toml"), "project", "requires-python"),
    },
  ];
}

const SIGNAL_FILES: Record<RuntimeId, readonly string[]> = {
  node: ["package.json", ".nvmrc", ".node-version"],
  php: ["composer.json", ".php-version"],
  python: ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", ".python-version"],
};

/** The runtimes the project at `root` uses, with the version it declares. Root files only. */
export function detectRuntimes(root: string): DetectedRuntime[] {
  const found: DetectedRuntime[] = [];
  for (const spec of RUNTIME_SPECS) {
    const sources = declaredSources(root, spec.id);
    const declaredHit = sources.find((s) => s.value !== null && cleanDeclared(s.value) !== null);
    const usesIt =
      declaredHit !== undefined || SIGNAL_FILES[spec.id].some((f) => readQuiet(root, f) !== null);
    if (!usesIt) continue;
    found.push({
      id: spec.id,
      declared: declaredHit ? cleanDeclared(declaredHit.value as string) : null,
      declaredFrom: declaredHit ? declaredHit.from : null,
    });
  }
  return found;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of `bin` from the real PATH, or null. Relative and empty PATH entries and
 * entries inside the project are skipped, so an interpreter planted in the repository (or in its
 * `node_modules/.bin`) is never the one that runs. On Windows the current folder would otherwise
 * be searched first.
 */
export function resolveBinary(
  bin: string,
  pathEnv: string | undefined,
  projectRoot: string,
): string | null {
  if (bin.includes("/") || bin.includes("\\") || bin.includes(sep)) return null;
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const entry of (pathEnv ?? "").split(delimiter)) {
    if (!isAbsolute(entry) || isInside(entry, projectRoot)) continue;
    for (const suffix of suffixes) {
      const candidate = join(entry, bin + suffix);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** True when the project's own version-manager pins should apply to the version probe. */
export function projectPinsApplied(): boolean {
  return process.env.KIT_UPSTREAM_PROJECT_PINS === "1";
}

/**
 * The installed version, from running the binary with `--version`. The binary is resolved to an
 * absolute path outside the project first. It runs from a neutral folder, because a version-manager
 * shim (mise, asdf, pyenv) reads the configuration of its working directory, and a repository that
 * is not yours must not be that directory. `KIT_UPSTREAM_PROJECT_PINS=1` runs it in the project so
 * the project's pin applies; do that only for a repository you trust.
 */
export async function readInstalledVersion(
  spec: RuntimeSpec,
  projectRoot: string,
): Promise<string | null> {
  // A fresh empty folder (mode 0700) holds no version-manager configuration and no other user can
  // write to it, which a shared temp folder cannot promise. It is removed when the probe is done.
  const probe = projectPinsApplied() ? null : mkdtempSync(join(tmpdir(), "kit-probe-"));
  try {
    for (const bin of spec.bins) {
      const path = resolveBinary(bin, process.env.PATH, projectRoot);
      if (path === null) continue;
      try {
        const { stdout, stderr } = await execFileAsync(path, ["--version"], {
          cwd: probe ?? projectRoot,
          timeout: 5_000,
        });
        const version = parseVersionOutput(`${stdout}\n${stderr}`);
        if (version) return version;
      } catch {
        // this binary did not answer: try the next name
      }
    }
    return null;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

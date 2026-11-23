/**
 * Container images for `kit scan`. kit has always scanned the files of a repository. An image that
 * runs in production can hold components the repository has no manifest for, so `[scan].images`
 * (and, when asked, the `FROM` lines of the Dockerfiles) name images to scan with osv-scanner and
 * trivy. Pure parsing plus a small bounded file walk. An image reference comes from a repository,
 * so it is validated before it reaches a command line: it cannot start with a dash, hold a space
 * or carry a control character. Pulling an image is network, so these runs are cloud-only and are
 * dropped in air-gap mode.
 */
import { opendirSync, type Dir, type Dirent } from "node:fs";
import { join } from "node:path";
import type { ScannerReportGap } from "./check-scanner-evidence.js";
import { sanitizeDisplayText } from "./display-text.js";
import { isScannerEnabled } from "./scanners.js";
import type { ScannerDef } from "./scanners.js";
import { readRegularFileIfPresent } from "./upstream-safe-read.js";
import { stripControl } from "./upstream-sources.js";

export interface ImageRef {
  ref: string;
  /** Where the reference came from, for the report. */
  source: string;
}

export interface SkippedImage {
  ref: string;
  reason: string;
  evidenceStatus?: ScannerReportGap | "stale";
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const IMAGE_TIMEOUT_MS = 600_000;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "vendor", "target", "coverage"]);
const MAX_DEPTH = 3;
const MAX_ENTRIES = 5000;
const MAX_DOCKERFILES = 50;

/** Strict image reference: tag, digest, registry with a port and path segments, nothing else. */
export function isSafeImageRef(ref: string): boolean {
  return SAFE_REF.test(ref) && !ref.includes("//") && !ref.endsWith("/");
}

/** Dockerfile instructions, with `\` continuations joined and comment lines dropped. */
export function joinContinuations(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (current === "" && line.trim().startsWith("#")) continue;
    if (line.trimEnd().endsWith("\\")) {
      current += `${line.trimEnd().slice(0, -1)} `;
      continue;
    }
    lines.push(current + line);
    current = "";
  }
  if (current !== "") lines.push(current);
  return lines;
}

function unquote(value: string): string {
  const first = value[0];
  return (first === '"' || first === "'") && value.endsWith(first) ? value.slice(1, -1) : value;
}

function substitute(token: string, args: ReadonlyMap<string, string>): string | null {
  let unresolved = false;
  const out = token.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, a, b) => {
      const value = args.get((a ?? b) as string);
      if (value === undefined || value === "") unresolved = true;
      return value ?? "";
    },
  );
  return unresolved || out.includes("$") ? null : out;
}

function recordDefault(definition: string | undefined, args: Map<string, string>): void {
  if (!definition) return;
  const [name, ...rest] = definition.split("=");
  if (rest.length > 0) args.set(name, unquote(rest.join("=")));
}

/** The images a Dockerfile builds on. `scratch` and earlier stage names are not images. */
export function parseDockerfileImages(text: string): { images: string[]; skipped: SkippedImage[] } {
  const images: string[] = [];
  const skipped: SkippedImage[] = [];
  const args = new Map<string, string>();
  const localBases = new Set(["scratch"]);
  for (const line of joinContinuations(text)) {
    const words = line.trim().split(/\s+/);
    const keyword = (words[0] ?? "").toLowerCase();
    if (keyword === "arg") {
      recordDefault(words[1], args);
      continue;
    }
    if (keyword !== "from") continue;
    const operands = words.slice(1).filter((w) => !w.startsWith("--"));
    const token = operands[0];
    if (!token) {
      skipped.push({
        ref: sanitizeDisplayText(line).slice(0, 80),
        reason: "FROM line without an image",
        evidenceStatus: "malformed",
      });
      continue;
    }
    const ref = substitute(token, args);
    const usesLocalBase = localBases.has(ref?.toLowerCase() ?? "");
    if (operands[1]?.toLowerCase() === "as" && operands[2])
      localBases.add(operands[2].toLowerCase());
    if (usesLocalBase) continue;
    if (ref === null) {
      skipped.push({
        ref: sanitizeDisplayText(token).slice(0, 80),
        reason: "uses an unresolved ARG, so the image is not known",
        evidenceStatus: "unsupported",
      });
    } else if (!isSafeImageRef(ref)) {
      skipped.push(invalidReference(ref, "FROM"));
    } else if (!images.includes(ref)) {
      images.push(ref);
    }
  }
  return { images, skipped };
}

function isDockerfileName(name: string): boolean {
  return (
    /^(Dockerfile|Containerfile)(\..+)?$/.test(name) || /\.(Dockerfile|Containerfile)$/.test(name)
  );
}

export interface DockerfileInventoryGap {
  path: string;
  reason: string;
  evidenceStatus: ScannerReportGap;
}

type DockerfileInventory = { files: string[]; gaps: DockerfileInventoryGap[] };

function walkableDirectory(name: string): boolean {
  return !name.startsWith(".") && !SKIPPED_DIRS.has(name);
}

/** Find relative Dockerfile paths and record where the bounded walk could not finish. */
export function discoverDockerfiles(root: string): DockerfileInventory {
  const inventory: DockerfileInventory = { files: [], gaps: [] };
  let seen = 0;
  let stopped = false;
  function incomplete(path: string, reason: string): void {
    inventory.gaps.push({ path, reason, evidenceStatus: "partial" });
  }
  function halt(path: string, reason: string): void {
    incomplete(path, reason);
    stopped = true;
  }
  function visit(entry: Dirent, parent: string, depth: number): void {
    const name = entry.name;
    const isDirectory = entry.isDirectory();
    if (isDirectory && !walkableDirectory(name)) return;
    if (stripControl(name) !== name) {
      incomplete(parent || ".", "entry has a control character in its name");
      return;
    }
    const path = parent ? `${parent}/${name}` : name;
    if (isDirectory) {
      if (depth >= MAX_DEPTH) incomplete(path, "depth limit reached");
      else walk(path, depth + 1);
    } else if (!isDockerfileName(name)) {
      return;
    } else if (entry.isFile()) {
      if (inventory.files.length >= MAX_DOCKERFILES) return halt(path, "Dockerfile limit reached");
      inventory.files.push(path);
    } else {
      inventory.gaps.push({
        path,
        reason: "Dockerfile is not a regular file",
        evidenceStatus: "unsupported",
      });
    }
  }
  function walk(rel: string, depth: number): void {
    let directory: Dir | undefined;
    const path = rel || ".";
    try {
      directory = opendirSync(join(root, rel));
      while (!stopped) {
        const entry = directory.readSync();
        if (!entry) break;
        if (++seen > MAX_ENTRIES) halt(path, "entry limit reached");
        else visit(entry, rel, depth);
      }
    } catch {
      incomplete(path, "directory could not be read");
    } finally {
      try {
        directory?.closeSync();
      } catch {
        incomplete(path, "directory could not be closed");
      }
    }
  }

  walk("", 0);
  inventory.files.sort();
  inventory.gaps.sort((a, b) => a.path.localeCompare(b.path));
  return inventory;
}

/** Dockerfile paths under root, relative and sorted. */
export function findDockerfiles(root: string): string[] {
  return discoverDockerfiles(root).files;
}

/** `[scan].images` as read from a config that is not schema-checked: a list of strings, else nothing. */
export function configuredImages(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export interface CollectOptions {
  /** `[scan].images`. */
  configured: readonly string[];
  /** `[scan].images_from_dockerfiles`: also read the FROM lines of the Dockerfiles. */
  fromDockerfiles: boolean;
}

function invalidReference(ref: string, fallback: string): SkippedImage {
  return {
    ref: sanitizeDisplayText(ref).slice(0, 80) || fallback,
    reason: "not a valid image reference",
    evidenceStatus: "malformed",
  };
}

export function collectImages(
  root: string,
  options: CollectOptions,
): { images: ImageRef[]; skipped: SkippedImage[] } {
  const images: ImageRef[] = [];
  const skipped: SkippedImage[] = [];
  const add = (ref: string, source: string): void => {
    if (!images.some((i) => i.ref === ref)) images.push({ ref, source });
  };
  for (const ref of options.configured) {
    if (isSafeImageRef(ref)) add(ref, "[scan].images");
    else skipped.push(invalidReference(ref, "[scan].images"));
  }
  if (!options.fromDockerfiles) return { images, skipped };
  const { files, gaps } = discoverDockerfiles(root);
  for (const { path, reason, evidenceStatus } of gaps) {
    skipped.push({ ref: sanitizeDisplayText(path) || ".", reason, evidenceStatus });
  }
  for (const rel of files) {
    const target = sanitizeDisplayText(rel) || "Dockerfile";
    let text: string | null;
    try {
      text = readRegularFileIfPresent(join(root, rel));
    } catch {
      skipped.push({
        ref: target,
        reason: "Dockerfile could not be read",
        evidenceStatus: "partial",
      });
      continue;
    }
    if (text === null) {
      skipped.push({ ref: target, reason: "Dockerfile disappeared", evidenceStatus: "stale" });
      continue;
    }
    const parsed = parseDockerfileImages(text);
    for (const ref of parsed.images) add(ref, "Dockerfile");
    for (const s of parsed.skipped) skipped.push({ ...s, ref: `${target}: ${s.ref}` });
  }
  return { images, skipped };
}

/**
 * One osv-scanner run and one trivy run per image, as scanner definitions `runScanners` can run.
 * They honour the `[scan].delegates` allow-list, need the network (so air gap drops them) and get
 * a long timeout, because the first run pulls the image.
 */
export function imageScanners(
  images: readonly ImageRef[],
  delegates?: readonly string[],
): ScannerDef[] {
  const defs: ScannerDef[] = [];
  for (const { ref } of images) {
    if (isScannerEnabled("osv-scanner", delegates)) {
      defs.push({
        id: `osv-scanner:image:${ref}`,
        bin: "osv-scanner",
        args: ["scan", "image", "--format", "json", ref],
        format: "osv",
        findingsExit: 1,
        cloudOnly: true,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
    }
    if (isScannerEnabled("trivy", delegates)) {
      defs.push({
        id: `trivy:image:${ref}`,
        bin: "trivy",
        evidence: "trivy-image",
        args: ["image", "--format", "json", "--list-all-pkgs", "--quiet", ref],
        format: "sarif",
        cloudOnly: true,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
    }
  }
  return defs;
}

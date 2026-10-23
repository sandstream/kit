/**
 * Container images for `kit scan`. kit has always scanned the files of a repository. An image that
 * runs in production can hold components the repository has no manifest for, so `[scan].images`
 * (and, when asked, the `FROM` lines of the Dockerfiles) name images to scan with osv-scanner and
 * trivy. Pure parsing plus a small bounded file walk. An image reference comes from a repository,
 * so it is validated before it reaches a command line: it cannot start with a dash, hold a space
 * or carry a control character. Pulling an image is network, so these runs are cloud-only and are
 * dropped in air-gap mode.
 */
import { readdirSync } from "node:fs";
import { isScannerEnabled } from "./scanners.js";
import type { ScannerDef } from "./scanners.js";
import { readRegularFileIfPresent } from "./upstream-safe-read.js";
import { stripControl } from "./upstream-sources.js";
import { join } from "node:path";

export interface ImageRef {
  ref: string;
  /** Where the reference came from, for the report. */
  source: string;
}

export interface SkippedImage {
  ref: string;
  reason: string;
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

function joinContinuations(text: string): string[] {
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

/** The images a Dockerfile builds on. `scratch` and earlier stage names are not images. */
export function parseDockerfileImages(text: string): { images: string[]; skipped: SkippedImage[] } {
  const images: string[] = [];
  const skipped: SkippedImage[] = [];
  const args = new Map<string, string>();
  const stages = new Set<string>();
  for (const line of joinContinuations(text)) {
    const words = line.trim().split(/\s+/);
    const keyword = (words[0] ?? "").toLowerCase();
    if (keyword === "arg" && words[1]) {
      const [name, ...rest] = words[1].split("=");
      if (rest.length > 0) args.set(name, unquote(rest.join("=")));
      continue;
    }
    if (keyword !== "from") continue;
    const operands = words.slice(1).filter((w) => !w.startsWith("--"));
    const token = operands[0];
    if (operands[1]?.toLowerCase() === "as" && operands[2]) stages.add(operands[2].toLowerCase());
    if (!token) {
      skipped.push({
        ref: stripControl(line.trim()).slice(0, 80),
        reason: "FROM line without an image",
      });
      continue;
    }
    if (token.toLowerCase() === "scratch" || stages.has(token.toLowerCase())) continue;
    const ref = substitute(token, args);
    if (ref === null) {
      skipped.push({
        ref: stripControl(token).slice(0, 80),
        reason: "uses an unresolved ARG, so the image is not known",
      });
    } else if (!isSafeImageRef(ref)) {
      skipped.push({ ref: stripControl(ref).slice(0, 80), reason: "not a valid image reference" });
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

/** Dockerfile paths under `root`, relative and sorted. Symlinks and vendored folders are skipped. */
export function findDockerfiles(root: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES || found.length >= MAX_DOCKERFILES) return;
      if (stripControl(entry.name) !== entry.name) continue; // a name with control characters is never printed
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isFile() && isDockerfileName(entry.name)) found.push(childRel);
      else if (
        entry.isDirectory() &&
        depth < MAX_DEPTH &&
        !entry.name.startsWith(".") &&
        !SKIPPED_DIRS.has(entry.name)
      ) {
        walk(childRel, depth + 1);
      }
    }
  };
  walk("", 0);
  return found.sort();
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
    else
      skipped.push({ ref: stripControl(ref).slice(0, 80), reason: "not a valid image reference" });
  }
  if (!options.fromDockerfiles) return { images, skipped };
  for (const rel of findDockerfiles(root)) {
    let text: string | null;
    try {
      text = readRegularFileIfPresent(join(root, rel));
    } catch (err) {
      skipped.push({ ref: rel, reason: err instanceof Error ? err.message : "could not be read" });
      continue;
    }
    if (text === null) continue;
    const parsed = parseDockerfileImages(text);
    for (const ref of parsed.images) add(ref, "Dockerfile");
    for (const s of parsed.skipped) skipped.push({ ref: `${rel}: ${s.ref}`, reason: s.reason });
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
        cloudOnly: true,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
    }
    if (isScannerEnabled("trivy", delegates)) {
      defs.push({
        id: `trivy:image:${ref}`,
        bin: "trivy",
        args: ["image", "--format", "sarif", "--quiet", ref],
        format: "sarif",
        cloudOnly: true,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
    }
  }
  return defs;
}

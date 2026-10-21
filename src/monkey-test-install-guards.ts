/** Checks `kit monkey-test init --install` runs before it trusts the repo or the installed package. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { MonkeyPackageJson } from "./monkey-test-contract.js";
import { isUnsafeEntry } from "./triage-sandbox.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
/** A registry version, never a range, tag, URL or git spec: it ends up in the `npm pack` spec. */
export const PLAIN_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLAIN_PACKAGE_MANAGER =
  /^(?:npm|pnpm|yarn|bun)(?:@\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+sha\d+\.[a-f0-9]+)?)?$/;

/** Corepack downloads whatever `packageManager` names, including a URL. Accept only plain forms. */
export function packageManagerRefusal(pkg: MonkeyPackageJson): string | null {
  const declared = pkg.packageManager;
  if (declared === undefined || PLAIN_PACKAGE_MANAGER.test(declared)) return null;
  return `packageManager "${declared.slice(0, 60)}" is not a plain name@version, so corepack could fetch a package manager from elsewhere`;
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Repo files that make an install run repository code before triage could see it. */
export function installRunsRepoCode(root: string): string | null {
  if (existsSync(join(root, ".pnpmfile.cjs"))) return ".pnpmfile.cjs runs during pnpm install";
  for (const file of [".yarnrc.yml", ".yarnrc"]) {
    const text = readIfPresent(join(root, file));
    if (/^\s*(yarnPath|yarn-path)\b/m.test(text)) return `${file} sets a custom yarn binary`;
    if (/^\s*plugins\s*:/m.test(text)) return `${file} loads yarn plugins`;
  }
  for (const file of [".npmrc", "pnpm-workspace.yaml"]) {
    if (/^\s*(?:global-)?pnpmfile\s*[=:]/im.test(readIfPresent(join(root, file)))) {
      return `${file} sets a pnpm hook file`;
    }
  }
  return null;
}

function listFiles(dir: string, base: string = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    return [relative(base, full).replaceAll("\\", "/")];
  });
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Files that differ between the installed package and the reference tarball. Empty means identical. */
export function compareTrees(installedDir: string, referenceDir: string): string[] {
  const installed = new Set(listFiles(installedDir));
  const reference = listFiles(referenceDir);
  const problems: string[] = [];
  for (const file of reference) {
    if (!installed.has(file)) problems.push(`missing: ${file}`);
    else if (sha256(join(installedDir, file)) !== sha256(join(referenceDir, file))) {
      problems.push(`modified: ${file}`);
    }
  }
  const known = new Set(reference);
  for (const file of installed) if (!known.has(file)) problems.push(`extra: ${file}`);
  return problems;
}

/**
 * Compare the installed package against the tarball the public registry serves for that version.
 * Runs in a scratch directory with an empty npm config, so no repo setting redirects the download.
 */
export async function verifyAgainstRegistry(
  installedDir: string,
  version: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!PLAIN_SEMVER.test(version)) {
    return {
      ok: false,
      detail: "the installed version is not a plain semver, so it cannot be checked",
    };
  }
  const scratch = mkdtempSync(join(tmpdir(), "kit-pkg-verify-"));
  try {
    const userconfig = join(scratch, "npmrc");
    writeFileSync(userconfig, "");
    const packed = await execFileNoThrow(
      "npm",
      [
        "pack",
        `@playwright/test@${version}`,
        `--registry=${PUBLIC_REGISTRY}`,
        `--userconfig=${userconfig}`,
        "--ignore-scripts",
        "--silent",
      ],
      { cwd: scratch, timeout: 120_000 },
    );
    const tarball = packed.stdout.trim().split("\n").pop()?.trim();
    if (!packed.ok || !tarball) {
      return {
        ok: false,
        detail: `could not fetch the registry tarball: ${packed.stderr.trim().slice(0, 200)}`,
      };
    }
    if (!/^[\w.-]+\.tgz$/.test(tarball)) return { ok: false, detail: "unexpected tarball name" };
    // List before extracting: a link or a path outside the package root never reaches the disk.
    const listing = await execFileNoThrow("tar", ["-tvzf", tarball], { cwd: scratch });
    if (!listing.ok || listing.stdout.split("\n").some((line) => isUnsafeEntry(line))) {
      return { ok: false, detail: "the registry tarball has an unsafe entry or cannot be listed" };
    }
    const unpacked = await execFileNoThrow("tar", ["-xzf", tarball], { cwd: scratch });
    if (!unpacked.ok) return { ok: false, detail: "could not unpack the registry tarball" };
    const problems = compareTrees(realpathSync(installedDir), join(scratch, "package"));
    return problems.length === 0
      ? { ok: true, detail: "installed files match the registry tarball" }
      : {
          ok: false,
          detail: `installed files differ from the registry tarball (${problems.slice(0, 3).join(", ")})`,
        };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

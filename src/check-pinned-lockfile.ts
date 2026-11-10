/** Decide whether a committed npm lockfile resolves the version ranges in package.json. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const NPM_LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json"] as const;

type DepMap = Record<string, string> | undefined;

export interface NodeManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * `covered`: the lockfile that resolves every range; `reason`: why no lockfile does, for the
 * check detail. A repo that sets `[scan] strict_pins = true` gets neither, so ranges stay unpinned.
 */
export interface LockfileCover {
  covered?: string;
  reason?: string;
}

function sameDeps(a: DepMap, b: DepMap): boolean {
  const left = Object.entries(a ?? {});
  const right = b ?? {};
  return left.length === Object.keys(right).length && left.every(([k, v]) => right[k] === v);
}

async function isTracked(root: string, file: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["ls-files", "--", file], { timeout: 5_000, cwd: root });
    return stdout.trim() !== "";
  } catch {
    return false; // not a git repo, or git is missing: nothing proves the lockfile is committed
  }
}

async function strictPins(root: string): Promise<boolean> {
  try {
    const { loadConfig } = await import("./config.js");
    return (await loadConfig(resolve(root, ".kit.toml"))).scan?.strict_pins === true;
  } catch {
    return false;
  }
}

/** npm writes the root manifest's ranges into `packages[""]`; equal ranges mean `npm ci` will accept it. */
async function inSync(root: string, file: string, manifest: NodeManifest): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(resolve(root, file), "utf-8")) as {
      packages?: Record<string, NodeManifest>;
    };
    const top = lock.packages?.[""];
    return (
      top !== undefined &&
      sameDeps(manifest.dependencies, top.dependencies) &&
      sameDeps(manifest.devDependencies, top.devDependencies)
    );
  } catch {
    return false;
  }
}

export async function npmLockfileCover(root: string, manifest: NodeManifest): Promise<LockfileCover> {
  if (await strictPins(root)) return {};
  for (const file of NPM_LOCKFILES) {
    if (!(await isTracked(root, file))) continue;
    if (await inSync(root, file, manifest)) return { covered: file };
    return { reason: `${file} is committed but out of sync with package.json` };
  }
  return {};
}

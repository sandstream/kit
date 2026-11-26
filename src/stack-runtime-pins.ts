/**
 * The runtime versions `kit init` pins, read from what the repo declares (.tool-versions, Volta,
 * .node-version/.nvmrc, engines.node, .python-version, requires-python) and the installed runtime.
 * Split from `stack-detector.ts`; no guess is presented as detected.
 */
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { npmRangeAdmits, pep440Admits, singleNpmMajor } from "./runtime-range.js";

/** The package.json fields the Node pin reads. */
interface NodePinFields {
  volta?: { node?: string };
  engines?: { node?: string };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The installed version of a runtime (`node`, `python`), or null when it is not installed. */
export type InstalledVersion = (tool: string) => Promise<string | null>;

export interface DetectOptions {
  /** Measures installed runtimes; injected so tests do not read the machine they run on. */
  installedVersion?: InstalledVersion;
}

/** The version `kit lock` will compare a pin against: the same probe, the same binary. */
export const measureInstalled: InstalledVersion = async (tool) => {
  const { describeTool } = await import("./tool-inventory.js");
  return (await describeTool(tool)).installed;
};

/** The Node major an `engines.node` value pins. One major (`20`, `^20.1`) is that major. A
 *  range (`>=20.0.0`) is not narrowed to its floor: the installed major when the range admits
 *  it, so `kit lock` does not reject the Node the repo allows; the floor only when it does not. */
async function nodeFromEngines(range: string, installed: InstalledVersion): Promise<string | null> {
  const single = singleNpmMajor(range);
  if (single) return single;
  const floor = range.match(/(\d+)/)?.[1] ?? null;
  const have = await installed("node");
  const major = have?.match(/^v?(\d+)/)?.[1];
  return major && npmRangeAdmits(range, have as string) ? major : floor;
}

/** Resolve the Node major to pin, respecting the repo's existing truth.
 *  Precedence: .tool-versions > Volta > .node-version / .nvmrc > engines.node > 22.
 *  (Respecting these avoids installing the wrong runtime, the #1 brownfield trap.) */
export async function resolveNodeVersion(
  cwd: string,
  pkg: NodePinFields,
  installed: InstalledVersion,
): Promise<string> {
  const toolVersions = await readFile(join(cwd, ".tool-versions"), "utf-8").catch(() => null);
  if (toolVersions) {
    const m = toolVersions.match(/^\s*nodejs?\s+v?(\d+)/m);
    if (m) return m[1];
  }
  if (pkg.volta?.node) {
    const m = pkg.volta.node.match(/(\d+)/);
    if (m) return m[1];
  }
  for (const f of [".node-version", ".nvmrc"]) {
    const c = await readFile(join(cwd, f), "utf-8").catch(() => null);
    if (c) {
      const m = c.match(/v?(\d+)/);
      if (m) return m[1];
    }
  }
  if (pkg.engines?.node) {
    const fromEngines = await nodeFromEngines(pkg.engines.node, installed);
    if (fromEngines) return fromEngines;
  }
  return "22";
}

/** The installed Python minor when `requires-python` admits it; null when it does not, or
 *  when the pyproject declares no `requires-python`. */
async function pythonFromRequires(
  pyproject: string,
  installed: InstalledVersion,
): Promise<string | null> {
  const spec = pyproject.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!spec) return null;
  const have = await installed("python");
  const minor = have?.match(/^(\d+\.\d+)/)?.[1];
  return minor && pep440Admits(spec, have as string) ? minor : null;
}

/** Resolve the Python minor to pin: .python-version > .tool-versions > requires-python (the
 *  installed minor it admits). Null when the repo declares none: a default such as 3.12 would
 *  be a guess presented as detected, and the generator reports the gap instead. */
async function resolvePythonVersion(
  cwd: string,
  pyproject: string,
  installed: InstalledVersion,
): Promise<string | null> {
  const pv = await readFile(join(cwd, ".python-version"), "utf-8").catch(() => null);
  if (pv) {
    const m = pv.match(/(\d+\.\d+)/);
    if (m) return m[1];
  }
  const tv = await readFile(join(cwd, ".tool-versions"), "utf-8").catch(() => null);
  if (tv) {
    const m = tv.match(/^\s*python\s+v?(\d+\.\d+)/m);
    if (m) return m[1];
  }
  return pythonFromRequires(pyproject, installed);
}

/** A pyproject that declares a project or a package manager's settings. One holding only
 *  tool config (`[tool.pyright]`, `[tool.ruff]`) is common in repos that are not Python. */
export const PYPROJECT_PROJECT =
  /^\s*\[(project|build-system|dependency-groups|tool\.(poetry|uv|pdm|hatch|flit|setuptools))\b/m;

/** uv is the installer only when the repo says so: its lockfile or its own config table. */
async function usesUv(cwd: string, pyproject: string): Promise<boolean> {
  return /^\s*\[tool\.uv\b/m.test(pyproject) || (await exists(join(cwd, "uv.lock")));
}

export async function pythonTools(
  cwd: string,
  pyproject: string,
  installed: InstalledVersion,
): Promise<Record<string, string>> {
  const tools: Record<string, string> = {};
  const python = await resolvePythonVersion(cwd, pyproject, installed);
  if (python) tools.python = python;
  if (await usesUv(cwd, pyproject)) tools.uv = "latest";
  return tools;
}

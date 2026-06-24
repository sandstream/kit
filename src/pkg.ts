/**
 * kit pkg — Install packages from any ecosystem with mandatory triage.
 *
 * Usage:
 *   kit pkg npm:express
 *   kit pkg pip:requests
 *   kit pkg brew:trivy
 *   kit pkg docker:stalwartlabs/stalwart
 *   kit pkg go:github.com/sigstore/cosign/v2/cmd/cosign@latest
 *   kit pkg cargo:ripgrep
 */

import { runTriage, type TriageType } from "./triage.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

export interface PkgSpec {
  ecosystem: string;
  name: string;
  version?: string;
}

export interface PkgResult {
  spec: PkgSpec;
  triagePassed: boolean;
  installed: boolean;
  output: string;
}

/**
 * Each ecosystem maps to a `(bin, args[])` builder — NEVER a shell string.
 * The package name/version are user-supplied (`kit pkg npm:<name>@<ver>`), so
 * they must reach the package manager as discrete argv elements: passed through
 * `execFile` they cannot break out into a second command, even if they contain
 * `;`, `|`, `$(…)`, backticks, or spaces. (This is the no-shell discipline the
 * rest of kit already follows via `execFileNoThrow`.)
 */
type InstallSpec = { bin: string; args: string[] };
const ECOSYSTEM_MAP: Record<
  string,
  { triageType: TriageType; install: (name: string, version?: string) => InstallSpec }
> = {
  npm: {
    triageType: "npm",
    install: (name, ver) => ({ bin: "npm", args: ["install", ver ? `${name}@${ver}` : name] }),
  },
  "npm-g": {
    triageType: "npm",
    install: (name, ver) => ({
      bin: "npm",
      args: ["install", "-g", ver ? `${name}@${ver}` : name],
    }),
  },
  pnpm: {
    triageType: "npm",
    install: (name, ver) => ({ bin: "pnpm", args: ["add", ver ? `${name}@${ver}` : name] }),
  },
  pip: {
    triageType: "pip",
    install: (name, ver) => ({ bin: "pip", args: ["install", ver ? `${name}==${ver}` : name] }),
  },
  brew: {
    triageType: "repo",
    install: (name) => ({ bin: "brew", args: ["install", name] }),
  },
  docker: {
    triageType: "docker",
    install: (name, ver) => ({
      bin: "docker",
      args: ["pull", ver ? `${name}:${ver}` : `${name}:latest`],
    }),
  },
  go: {
    triageType: "repo",
    install: (name) => ({ bin: "go", args: ["install", name] }),
  },
  cargo: {
    triageType: "repo",
    install: (name) => ({ bin: "cargo", args: ["install", name] }),
  },
};

/**
 * Build the `(bin, args[])` for a parsed spec, or null for an unknown ecosystem.
 * Pure — exported so the no-shell argv contract is regression-tested.
 */
export function buildInstallSpec(spec: PkgSpec): InstallSpec | null {
  const eco = ECOSYSTEM_MAP[spec.ecosystem];
  return eco ? eco.install(spec.name, spec.version) : null;
}

/**
 * Parse "npm:express@4.18.0" → { ecosystem: "npm", name: "express", version: "4.18.0" }
 */
export function parsePkgSpec(input: string): PkgSpec | null {
  const colonIdx = input.indexOf(":");
  if (colonIdx === -1) return null;

  const ecosystem = input.slice(0, colonIdx);
  const rest = input.slice(colonIdx + 1);

  // Handle @scoped packages like @socketsecurity/cli@1.0.0
  let name: string;
  let version: string | undefined;

  if (rest.startsWith("@")) {
    // Scoped: @scope/pkg@version
    const lastAt = rest.lastIndexOf("@");
    if (lastAt > 0 && lastAt !== rest.indexOf("@")) {
      name = rest.slice(0, lastAt);
      version = rest.slice(lastAt + 1);
    } else {
      name = rest;
    }
  } else {
    const atIdx = rest.indexOf("@");
    if (atIdx > 0) {
      name = rest.slice(0, atIdx);
      version = rest.slice(atIdx + 1);
    } else {
      name = rest;
    }
  }

  return { ecosystem, name, version };
}

/**
 * Get GitHub repo URL for brew formulas
 */
async function getBrewRepoUrl(name: string): Promise<string | null> {
  const res = await execFileNoThrow("brew", ["info", "--json=v2", name], { timeout: 15_000 });
  if (!res.ok) {
    // brew not available or formula not found — try GitHub search
    return `https://github.com/search?q=${encodeURIComponent(name)}`;
  }
  try {
    const data = JSON.parse(res.stdout);
    const formula = data.formulae?.[0] || data.casks?.[0];
    const homepage = formula?.homepage || "";
    if (homepage.includes("github.com")) return homepage;
    return null;
  } catch {
    return `https://github.com/search?q=${encodeURIComponent(name)}`;
  }
}

/**
 * Install a package with mandatory triage
 */
export async function installPkg(spec: PkgSpec): Promise<PkgResult> {
  const eco = ECOSYSTEM_MAP[spec.ecosystem];
  if (!eco) {
    return {
      spec,
      triagePassed: false,
      installed: false,
      output: `Unknown ecosystem: ${spec.ecosystem}\nSupported: ${Object.keys(ECOSYSTEM_MAP).join(", ")}`,
    };
  }

  // Step 1: Triage
  let triageTarget = spec.name;

  if (spec.ecosystem === "brew") {
    const repoUrl = await getBrewRepoUrl(spec.name);
    if (repoUrl && repoUrl.includes("github.com")) {
      triageTarget = repoUrl;
    }
  } else if (spec.ecosystem === "docker" && !spec.name.includes("/")) {
    // Official Docker images — skip repo triage, do image triage
    triageTarget = spec.name;
  } else if (spec.ecosystem === "go") {
    const ghParts = spec.name.replace("@latest", "").split("/").slice(0, 3);
    triageTarget = `https://${ghParts.join("/")}`;
  }

  const triageResult = await runTriage(eco.triageType, triageTarget);

  if (!triageResult.passed) {
    return {
      spec,
      triagePassed: false,
      installed: false,
      output: `${triageResult.output}\n\n❌ Triage failed. Package not installed.\nReview warnings above. Use --force to override (not recommended).`,
    };
  }

  // Step 2: Install
  const { bin, args } = eco.install(spec.name, spec.version);
  const display = `${bin} ${args.join(" ")}`;
  const res = await execFileNoThrow(bin, args, { timeout: 300_000 });
  if (res.ok) {
    return {
      spec,
      triagePassed: true,
      installed: true,
      output: `✅ Triage passed\n✅ Installed: ${display}\n${res.stdout}${res.stderr ? "\n" + res.stderr : ""}`,
    };
  }
  return {
    spec,
    triagePassed: true,
    installed: false,
    output: `✅ Triage passed\n❌ Install failed: ${display}\n${res.stderr || res.stdout || ""}`,
  };
}

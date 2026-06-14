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

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { runTriage, type TriageType } from "./triage.js";

const execAsync = promisify(execCb);

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

const ECOSYSTEM_MAP: Record<string, { triageType: TriageType; installCmd: (name: string, version?: string) => string }> = {
  npm: {
    triageType: "npm",
    installCmd: (name, ver) => ver ? `npm install ${name}@${ver}` : `npm install ${name}`,
  },
  "npm-g": {
    triageType: "npm",
    installCmd: (name, ver) => ver ? `npm install -g ${name}@${ver}` : `npm install -g ${name}`,
  },
  pnpm: {
    triageType: "npm",
    installCmd: (name, ver) => ver ? `pnpm add ${name}@${ver}` : `pnpm add ${name}`,
  },
  pip: {
    triageType: "pip",
    installCmd: (name, ver) => ver ? `pip install ${name}==${ver}` : `pip install ${name}`,
  },
  brew: {
    triageType: "repo",
    installCmd: (name) => `brew install ${name}`,
  },
  docker: {
    triageType: "docker",
    installCmd: (name, ver) => ver ? `docker pull ${name}:${ver}` : `docker pull ${name}:latest`,
  },
  go: {
    triageType: "repo",
    installCmd: (name) => `go install ${name}`,
  },
  cargo: {
    triageType: "repo",
    installCmd: (name) => `cargo install ${name}`,
  },
};

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
  try {
    const { stdout } = await execAsync(`brew info --json=v2 ${name} 2>/dev/null`);
    const data = JSON.parse(stdout);
    const formula = data.formulae?.[0] || data.casks?.[0];
    const homepage = formula?.homepage || "";
    if (homepage.includes("github.com")) return homepage;
    return null;
  } catch {
    // brew not available or formula not found — try GitHub search
    return `https://github.com/search?q=${name}`;
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
  const cmd = eco.installCmd(spec.name, spec.version);
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 300_000 });
    return {
      spec,
      triagePassed: true,
      installed: true,
      output: `✅ Triage passed\n✅ Installed: ${cmd}\n${stdout}${stderr ? "\n" + stderr : ""}`,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      spec,
      triagePassed: true,
      installed: false,
      output: `✅ Triage passed\n❌ Install failed: ${cmd}\n${err.stderr || err.message || ""}`,
    };
  }
}

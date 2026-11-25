import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROFILE_RULES,
  RUN_ENV,
  SEATBELT,
  SEATBELT_SYSTEM_PROFILE,
  readLaunchScripts,
  runtimeProfile,
} from "./launch-profile.js";
import { relativePath } from "./npm-lock-workspaces.js";
import { readSnapshotFile, unchanged } from "./snapshot-io.js";
import { RUNTIME_TREE_RECIPE } from "./runtime-tree.js";

import { fingerprintKitBuild } from "./launch-build-identity.js";
import { parseExpectedNpmArtifacts, type ExpectedNpmArtifact } from "./runtime-npm-policy.js";

interface IncomingLaunchPolicy {
  schema: 1;
  entry: string;
  outputDirectory: string;
  timeoutMs: number;
  npmArtifacts?: ExpectedNpmArtifact[];
  requiredCheck?: "dockerfile-secrets";
}

function validOutputDirectory(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 4096 &&
    isAbsolute(path) &&
    normalize(path) === path &&
    !/[\x00-\x1f\x7f]/.test(path)
  );
}

function launchPolicy(value: unknown): value is IncomingLaunchPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<IncomingLaunchPolicy>;
  const requiredKeys = Object.keys(value)
    .filter((key) => key !== "npmArtifacts" && key !== "requiredCheck")
    .sort()
    .join(",");
  return (
    requiredKeys === "entry,outputDirectory,schema,timeoutMs" &&
    policy.schema === 1 &&
    typeof policy.entry === "string" &&
    relativePath(policy.entry) &&
    /\.(mjs|cjs|js)$/.test(policy.entry) &&
    validOutputDirectory(policy.outputDirectory) &&
    typeof policy.timeoutMs === "number" &&
    Number.isSafeInteger(policy.timeoutMs) &&
    policy.timeoutMs >= 1000 &&
    policy.timeoutMs <= 30_000 &&
    (!Object.hasOwn(policy, "requiredCheck") || policy.requiredCheck === "dockerfile-secrets")
  );
}

function fingerprint(path: string) {
  const info = lstatSync(path, { bigint: true });
  const { sha256 } = readSnapshotFile(path, info, 192 * 1024 * 1024);
  return {
    path,
    sha256,
    check: () => unchanged(info, lstatSync(path, { bigint: true })),
  };
}

export type PreparedLaunchPolicy = {
  ok: true;
  policyDigest: string;
  policy: IncomingLaunchPolicy & { npmArtifacts: ExpectedNpmArtifact[] };
  runtime: string;
  runtimeDigest: string;
  scripts: ReturnType<typeof readLaunchScripts>;
  checkRuntime: () => boolean;
};

type Refused = {
  ok: false;
  reason: "invalid-run-policy" | "run-platform-unsupported" | "run-delegate-unavailable";
};

/** The fixed delegate has no network destinations, supplied credentials, or child processes. */
export function prepareLaunchPolicy(value: unknown): PreparedLaunchPolicy | Refused {
  if (!launchPolicy(value)) return { ok: false, reason: "invalid-run-policy" };
  const npmArtifacts = parseExpectedNpmArtifacts(value.npmArtifacts);
  if (!npmArtifacts) return { ok: false, reason: "invalid-run-policy" };
  if (process.platform !== "darwin" || process.arch !== "arm64")
    return { ok: false, reason: "run-platform-unsupported" };
  try {
    const runtime = realpathSync(process.execPath);
    const parent = realpathSync(dirname(value.outputDirectory));
    const outputDirectory = join(parent, basename(value.outputDirectory));
    const policy = { ...value, outputDirectory, npmArtifacts };
    const kitBuild = fingerprintKitBuild(fileURLToPath(new URL("..", import.meta.url)));
    const stamps = [runtime, SEATBELT, SEATBELT_SYSTEM_PROFILE].map(fingerprint);
    const scripts = readLaunchScripts();
    const build = execFileSync("/usr/bin/sw_vers", ["-buildVersion"], {
      encoding: "utf8",
      env: RUN_ENV,
      timeout: 3000,
    }).trim();
    if (!build) return { ok: false, reason: "run-delegate-unavailable" };
    const identity = [
      "kit.incoming-run-policy",
      1,
      "darwin-seatbelt-node",
      RUNTIME_TREE_RECIPE,
      kitBuild.digest,
      process.arch,
      build,
      stamps.map(({ path, sha256 }) => [path, sha256]),
      PROFILE_RULES,
      runtimeProfile.toString(),
      scripts,
      RUN_ENV,
      policy.entry,
      policy.outputDirectory,
      policy.timeoutMs,
      policy.npmArtifacts,
      ...(policy.requiredCheck ? [policy.requiredCheck] : []),
    ];
    return {
      ok: true,
      policy,
      runtime,
      runtimeDigest: stamps[0]!.sha256,
      scripts,
      policyDigest: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
      checkRuntime: () => kitBuild.check() && stamps.every((stamp) => stamp.check()),
    };
  } catch {
    return { ok: false, reason: "run-delegate-unavailable" };
  }
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import {
  BOOTSTRAP,
  PROFILE_RULES,
  RUN_ENV,
  SEATBELT,
  SEATBELT_SYSTEM_PROFILE,
} from "./launch-profile.js";
import { relativePath } from "./npm-lock-workspaces.js";
import { readSnapshotFile, unchanged } from "./snapshot-io.js";

interface IncomingLaunchPolicy {
  schema: 1;
  entry: string;
  outputDirectory: string;
  timeoutMs: number;
}

function launchPolicy(value: unknown): value is IncomingLaunchPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<IncomingLaunchPolicy>;
  const keys = Object.keys(value).sort().join(",");
  return (
    keys === "entry,outputDirectory,schema,timeoutMs" &&
    policy.schema === 1 &&
    typeof policy.entry === "string" &&
    relativePath(policy.entry) &&
    /\.(mjs|cjs|js)$/.test(policy.entry) &&
    typeof policy.outputDirectory === "string" &&
    isAbsolute(policy.outputDirectory) &&
    normalize(policy.outputDirectory) === policy.outputDirectory &&
    !/[\x00-\x1f\x7f]/.test(policy.outputDirectory) &&
    policy.outputDirectory.length <= 4096 &&
    typeof policy.timeoutMs === "number" &&
    Number.isSafeInteger(policy.timeoutMs) &&
    policy.timeoutMs >= 1000 &&
    policy.timeoutMs <= 30_000
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
  policy: IncomingLaunchPolicy;
  runtime: string;
  checkRuntime: () => boolean;
};

type Refused = {
  ok: false;
  reason: "invalid-run-policy" | "run-platform-unsupported" | "run-delegate-unavailable";
};

/** The fixed delegate has no network destinations, supplied credentials, or child processes. */
export function prepareLaunchPolicy(value: unknown): PreparedLaunchPolicy | Refused {
  if (!launchPolicy(value)) return { ok: false, reason: "invalid-run-policy" };
  if (process.platform !== "darwin" || process.arch !== "arm64")
    return { ok: false, reason: "run-platform-unsupported" };
  try {
    const runtime = realpathSync(process.execPath);
    const parent = realpathSync(dirname(value.outputDirectory));
    const outputDirectory = join(parent, basename(value.outputDirectory));
    const policy: IncomingLaunchPolicy = { ...value, outputDirectory };
    const stamps = [runtime, SEATBELT, SEATBELT_SYSTEM_PROFILE].map(fingerprint);
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
      process.arch,
      build,
      stamps.map(({ path, sha256 }) => [path, sha256]),
      PROFILE_RULES,
      BOOTSTRAP,
      RUN_ENV,
      policy.entry,
      policy.outputDirectory,
      policy.timeoutMs,
    ];
    return {
      ok: true,
      policy,
      runtime,
      policyDigest: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
      checkRuntime: () => stamps.every((stamp) => stamp.check()),
    };
  } catch {
    return { ok: false, reason: "run-delegate-unavailable" };
  }
}

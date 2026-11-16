import { dependencySections } from "./npm-lock-read.js";
import {
  issue,
  object,
  optionalPeers,
  pointer,
  readEdges,
  readObject,
  stringMap,
  text,
  validateFields,
  type Reader,
  type JsonRecord,
} from "./npm-lock-read.js";
import { rootConsistency, dependencyConsistency } from "./npm-lock-relations.js";
import { artifact } from "./npm-lock-sources.js";
import {
  workspaces,
  packagePath,
  linkPath,
  validateLinks,
  workspaceRecord,
} from "./npm-lock-workspaces.js";

export type NpmLockfileName = "package-lock.json" | "npm-shrinkwrap.json";
export interface NpmLockInput {
  manifest: Uint8Array;
  lockfile: Uint8Array;
  lockfileName: NpmLockfileName;
}

export type NpmDependencySection = (typeof dependencySections)[number];

export interface NpmPackage {
  path: string;
  name: string | null;
  version: string | null;
  resolved: string | null;
  integrity: string | null;
  /** Null means the lock did not record the indicator. It does not mean no scripts. */
  hasInstallScript: boolean | null;
  flags: {
    dev: boolean;
    optional: boolean;
    devOptional: boolean;
    inBundle: boolean;
    hasShrinkwrap: boolean;
  };
}

export interface NpmArtifact {
  packagePath: string;
  name: string | null;
  version: string | null;
  source:
    | "registry-tarball"
    | "remote-tarball"
    | "git"
    | "local-tarball"
    | "local-directory"
    | "bundled"
    | "unknown";
  resolved: string | null;
  integrity: string | null;
}

export interface NpmDependencyEdge {
  from: string;
  section: NpmDependencySection;
  name: string;
  spec: string;
  optional: boolean;
}

export type NpmLockIssueCode =
  | "dependency-identity-mismatch"
  | "duplicate-json-key"
  | "input-limit"
  | "invalid-integrity"
  | "invalid-json"
  | "invalid-link-path"
  | "invalid-link-record"
  | "invalid-package-path"
  | "invalid-schema"
  | "invalid-utf8"
  | "invalid-workspace-path"
  | "invalid-workspace-record"
  | "missing-dependency-target"
  | "missing-integrity"
  | "missing-link-target"
  | "missing-package-identity"
  | "missing-root"
  | "missing-workspace-record"
  | "nested-shrinkwrap"
  | "root-dependency-mismatch"
  | "root-identity-mismatch"
  | "script-indicator-mismatch"
  | "unknown-source"
  | "unsupported-link-target"
  | "unsupported-lock-version"
  | "unsupported-lockfile-name"
  | "unsupported-package-metadata"
  | "unsupported-source"
  | "unsupported-workspace-pattern"
  | "workspace-mismatch";

export interface NpmLockIssue {
  code: NpmLockIssueCode;
  file: "input" | "package.json" | NpmLockfileName;
  /** JSON pointer within the input, or an empty string for the whole input. */
  path: string;
  message: string;
}

export interface NpmLockInventory {
  schema: "kit.incoming-trust.npm-lock";
  schemaVersion: 1;
  lockfileName: NpmLockfileName | null;
  lockfileVersion: 2 | 3 | null;
  completeness: { status: "complete" | "incomplete"; scope: "supplied-npm-input-inventory" };
  verification: "not-performed";
  limitations: readonly [
    "artifact-content-not-verified",
    "dependency-script-content-not-complete",
    "workspace-manifests-not-supplied",
    "npm-resolution-not-reproduced",
  ];
  packages: NpmPackage[];
  artifacts: NpmArtifact[];
  edges: NpmDependencyEdge[];
  scripts: {
    packagePath: string;
    name: string;
    command: string;
    origin: "manifest" | "lockfile";
  }[];
  links: { path: string; target: string | null }[];
  workspaces: { patterns: string[]; packages: string[] };
  issues: NpmLockIssue[];
}

/** Read supplied npm data only. Inventory completeness never grants execution or approval. */

function packages(lock: JsonRecord, reader: Reader): void {
  if (!object(lock.packages)) {
    issue(reader, "invalid-schema", "/packages", "Expected a package location map.");
    return;
  }
  if (!Object.hasOwn(lock.packages, "")) {
    issue(reader, "missing-root", "/packages", "The root package record is required.");
  }
  const workspacePaths = new Set(reader.result.workspaces.packages);
  for (const [path, raw] of Object.entries(lock.packages)) {
    const at = `/packages/${pointer(path)}`;
    if (!object(raw)) {
      issue(reader, "invalid-schema", at, "Expected a package record.");
      continue;
    }
    packagePath(path, reader);
    validateFields(raw, reader, at);
    packageScripts(raw, path, reader, at);
    if (path && raw.workspaces !== undefined) {
      issue(
        reader,
        "unsupported-package-metadata",
        `${at}/workspaces`,
        "Nested workspace declarations require additional support.",
      );
    }
    const name = text(raw.name) ?? /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path)?.[1] ?? null;
    const pkg = {
      path,
      name,
      version: text(raw.version),
      resolved: text(raw.resolved),
      integrity: text(raw.integrity),
      flags: {
        dev: raw.dev === true,
        optional: raw.optional === true,
        devOptional: raw.devOptional === true,
        inBundle: raw.inBundle === true,
        hasShrinkwrap: raw.hasShrinkwrap === true,
      },
      hasInstallScript: typeof raw.hasInstallScript === "boolean" ? raw.hasInstallScript : null,
    };
    reader.result.packages.push(pkg);
    if (raw.link === true) linkPath(path, pkg.resolved, reader);
    else if (path && !(workspacePaths.has(path) && workspaceRecord(raw, path, reader)))
      artifact(pkg, raw, reader);
    readEdges(raw, path, reader, at);
  }
}

function packageScripts(raw: JsonRecord, path: string, reader: Reader, at: string): void {
  const scripts = stringMap(raw.scripts, reader, `${at}/scripts`);
  if (path) {
    for (const [name, command] of Object.entries(scripts)) {
      reader.result.scripts.push({ packagePath: path, name, command, origin: "lockfile" });
    }
    if (raw.hasShrinkwrap === true) {
      issue(
        reader,
        "nested-shrinkwrap",
        `${at}/hasShrinkwrap`,
        "Nested shrinkwrap content is not supplied to this inventory.",
      );
    }
    if (
      raw.hasInstallScript === false &&
      ["preinstall", "install", "postinstall"].some((name) => Object.hasOwn(scripts, name))
    ) {
      issue(
        reader,
        "script-indicator-mismatch",
        `${at}/hasInstallScript`,
        "Recorded scripts conflict with the install-script indicator.",
      );
    }
  }
}

function manifestScripts(manifest: JsonRecord, reader: Reader): void {
  validateFields(manifest, reader, "");
  optionalPeers(manifest.peerDependenciesMeta, reader, "/peerDependenciesMeta");
  for (const section of dependencySections) stringMap(manifest[section], reader, `/${section}`);
  reader.result.scripts = Object.entries(stringMap(manifest.scripts, reader, "/scripts")).map(
    ([name, command]) => ({ packagePath: "", name, command, origin: "manifest" }),
  );
}

export function inspectNpmLock(input: NpmLockInput): NpmLockInventory {
  const result: NpmLockInventory = {
    schema: "kit.incoming-trust.npm-lock",
    schemaVersion: 1,
    lockfileName: input.lockfileName,
    lockfileVersion: null,
    completeness: { status: "complete", scope: "supplied-npm-input-inventory" },
    verification: "not-performed",
    limitations: [
      "artifact-content-not-verified",
      "dependency-script-content-not-complete",
      "workspace-manifests-not-supplied",
      "npm-resolution-not-reproduced",
    ],
    packages: [],
    artifacts: [],
    edges: [],
    scripts: [],
    links: [],
    workspaces: { patterns: [], packages: [] },
    issues: [],
  };
  if (input.lockfileName !== "package-lock.json" && input.lockfileName !== "npm-shrinkwrap.json") {
    result.lockfileName = null;
    issue(
      { result, file: "input" },
      "unsupported-lockfile-name",
      "/lockfileName",
      "Expected package-lock.json or npm-shrinkwrap.json.",
    );
    return result;
  }
  const lockReader = { result, file: input.lockfileName };
  const manifestReader = { result, file: "package.json" as const };
  const manifest = readObject(input.manifest, manifestReader);
  const lock = readObject(input.lockfile, lockReader);
  if (manifest) manifestScripts(manifest, manifestReader);
  if (lock) {
    validateFields(lock, lockReader, "");
    if (lock.lockfileVersion === 2 || lock.lockfileVersion === 3) {
      result.lockfileVersion = lock.lockfileVersion;
      workspaces(manifest, lock, lockReader);
      packages(lock, lockReader);
      validateLinks(lock, lockReader);
      dependencyConsistency(lock, lockReader);
      if (manifest) rootConsistency(manifest, lock, lockReader);
    } else {
      issue(
        lockReader,
        "unsupported-lock-version",
        "/lockfileVersion",
        "Only lockfile versions 2 and 3 are supported.",
      );
    }
  }
  return result;
}

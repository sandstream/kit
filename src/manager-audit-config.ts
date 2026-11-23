import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { scannerRecord } from "./check-scanner-evidence.js";

export type Manager = "bun" | "pnpm" | "yarn";
const PUBLIC_REGISTRY = /^https:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/;

const npmKeys = new Set([
  "audit",
  "fund",
  "engine-strict",
  "strict-peer-dependencies",
  "auto-install-peers",
  "ignore-scripts",
  "ignore-pnpmfile",
  "node-linker",
  "shamefully-hoist",
  "package-manager-strict",
  "manage-package-manager-versions",
  "save-exact",
  "lockfile",
  "shared-workspace-lockfile",
  "store-dir",
  "virtual-store-dir",
]);
const yarnKeys = new Set([
  "nodeLinker",
  "enableGlobalCache",
  "enableTelemetry",
  "enableImmutableInstalls",
  "compressionLevel",
  "enableScripts",
  "enableColors",
  "enableMessageNames",
]);
const workspaceKeys = new Set([
  "packages",
  "catalog",
  "catalogs",
  "overrides",
  "packageExtensions",
  "patchedDependencies",
  "ignoredBuiltDependencies",
  "onlyBuiltDependencies",
  "neverBuiltDependencies",
  "allowBuilds",
  "minimumReleaseAge",
  "minimumReleaseAgeExclude",
  "supportedArchitectures",
  "nodeLinker",
  "shamefullyHoist",
  "publicHoistPattern",
  "hoistPattern",
  "autoInstallPeers",
  "strictPeerDependencies",
  "sharedWorkspaceLockfile",
  "ignoreScripts",
  "engineStrict",
  "managePackageManagerVersions",
  "packageManagerStrict",
  "preferWorkspacePackages",
  "linkWorkspacePackages",
  "saveWorkspaceProtocol",
]);

function meaningful(line: string): boolean {
  return line.trim() !== "" && !/^\s*#/.test(line);
}

function safeNpmRc(text: string): boolean {
  return text
    .split(/\r?\n/)
    .filter(meaningful)
    .every((line) => {
      if (/^\s*;/.test(line)) return true;
      const field = /^\s*([a-z][a-z-]*)\s*=\s*([^\r\n]*)\s*$/i.exec(line);
      if (!field) return false;
      const [, key, value] = field;
      return key.toLowerCase() === "registry"
        ? PUBLIC_REGISTRY.test(value.trim())
        : npmKeys.has(key.toLowerCase());
    });
}

function safeYarnRc(text: string): boolean {
  return text
    .split(/\r?\n/)
    .filter(meaningful)
    .every((line) => {
      const field = /^([a-zA-Z]+):\s*([a-zA-Z0-9_-]+)\s*(?:#.*)?$/.exec(line);
      if (field) return yarnKeys.has(field[1]);
      const registry = /^npmRegistryServer:\s*["']?(https:\/\/[^\s"']+)["']?\s*(?:#.*)?$/.exec(
        line,
      );
      return registry !== null && PUBLIC_REGISTRY.test(registry[1]);
    });
}

function safeWorkspaceConfig(text: string): boolean {
  // Recognize ordinary writer output without evaluating YAML aliases, tags, or merged settings.
  if (/(?:^|\s)(?:<<:|[&*!][\w-]+)|^\s*(?:registry|audit|ignoreRegistryErrors)\s*:/im.test(text))
    return false;
  return text
    .split(/\r?\n/)
    .filter(meaningful)
    .every((line) => {
      if (/^ {2}/.test(line)) return true;
      const field = /^([a-zA-Z][a-zA-Z0-9]*):/.exec(line);
      return field !== null && workspaceKeys.has(field[1]);
    });
}

function safeBunConfig(text: string): boolean {
  try {
    const config = parse(text);
    const install = config.install;
    if (!scannerRecord(install)) return install === undefined;
    if (
      install.scopes !== undefined &&
      (!scannerRecord(install.scopes) || Object.keys(install.scopes).length > 0)
    )
      return false;
    return (
      install.registry === undefined ||
      (typeof install.registry === "string" && PUBLIC_REGISTRY.test(install.registry))
    );
  } catch {
    return false;
  }
}

export function verifiedConfig(path: string, text: string): boolean {
  if (path.endsWith(".yarnrc.yml")) return safeYarnRc(text);
  if (path.endsWith("pnpm-workspace.yaml")) return safeWorkspaceConfig(text);
  if (path.endsWith("bunfig.toml")) return safeBunConfig(text);
  if (path.endsWith(".npmrc") || /[\\/]pnpm[\\/]rc$/.test(path)) return safeNpmRc(text);
  return text.trim() === "";
}

export function hasCustomAuditRegistry(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => {
    if (!value?.trim()) return false;
    if (
      /^(?:YARN_NPM_SCOPES|YARN_NPM_REGISTRIES|YARN_RC_FILENAME|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG))$/i.test(
        key,
      )
    )
      return true;
    return (
      /^(?:BUN|PNPM|YARN|NPM_CONFIG)_.*REGISTRY(?:_SERVER)?$/i.test(key) &&
      !PUBLIC_REGISTRY.test(value.trim())
    );
  });
}

export function auditConfigFiles(root: string, manager: Manager, env: NodeJS.ProcessEnv): string[] {
  const files = new Set<string>();
  const bases =
    manager === "yarn"
      ? [".yarnrc.yml", ".yarnrc"]
      : manager === "pnpm"
        ? [".npmrc", "pnpm-workspace.yaml", ".pnpmfile.cjs", "pnpmfile.cjs"]
        : [".npmrc", "bunfig.toml", ".bunfig.toml"];
  let dir = resolve(root);
  for (;;) {
    for (const name of bases) files.add(join(dir, name));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = env.HOME || env.USERPROFILE || homedir();
  for (const name of bases) files.add(join(home, name));
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  if (manager === "pnpm") files.add(join(config, "pnpm", "rc"));
  if (manager === "bun") files.add(join(config, ".bunfig.toml"));
  return [...files];
}

export function managerAuditEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !/^(?:BUN_|PNPM_|YARN_|NPM_CONFIG_|COREPACK_|NODE_ENV$|NODE_OPTIONS$)/i.test(key),
    ),
  );
  return {
    ...cleaned,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "0",
    YARN_IGNORE_PATH: "1",
    YARN_ENABLE_COLORS: "0",
    YARN_ENABLE_MESSAGE_NAMES: "1",
    YARN_ENABLE_TELEMETRY: "0",
    NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "false",
  };
}

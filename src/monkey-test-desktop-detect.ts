import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  MonkeyDesktopApp,
  MonkeyDesktopDriver,
  MonkeyPackageJson,
} from "./monkey-test-contract.js";
import { allMonkeyDependencies, readMonkeyText } from "./monkey-test-scan.js";

const TAURI_CONFIGS = [
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.conf.json5",
  "src-tauri/Tauri.toml",
] as const;

interface TauriConfig {
  productName?: unknown;
  identifier?: unknown;
  build?: { devUrl?: unknown; devPath?: unknown };
  package?: { productName?: unknown };
  tauri?: { bundle?: { identifier?: unknown } };
}

interface ElectronPackageJson extends MonkeyPackageJson {
  name?: unknown;
  productName?: unknown;
  build?: { appId?: unknown; productName?: unknown };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function readTauriConfig(path: string): Promise<TauriConfig | null> {
  const raw = await readMonkeyText(path);
  if (!raw) return null;
  try {
    if (path.endsWith(".toml")) return parseToml(raw) as TauriConfig;
    // JSON5 allows comments and trailing commas. Strip the common cases; a config that
    // still does not parse is reported without identity rather than guessed.
    const json = path.endsWith(".json5")
      ? raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")
      : raw;
    return JSON.parse(json) as TauriConfig;
  } catch {
    return {};
  }
}

/**
 * The folders this platform gives an app for its own data. Tauri's app_data_dir uses the
 * bundle identifier; Electron's userData and many hand-rolled Tauri stores use the
 * product name. Both are listed, because the check after a run must cover whichever the
 * app really writes to.
 */
export function platformDataDirs(
  names: string[],
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const bases =
    platform === "darwin"
      ? [join(home, "Library", "Application Support")]
      : platform === "win32"
        ? [
            env.APPDATA ?? join(home, "AppData", "Roaming"),
            env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
          ]
        : [
            env.XDG_DATA_HOME ?? join(home, ".local", "share"),
            env.XDG_CONFIG_HOME ?? join(home, ".config"),
          ];
  const dirs = new Set<string>();
  for (const name of names) for (const base of bases) dirs.add(join(base, name));
  return [...dirs];
}

function uniqueNames(...values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** Identity fields in Tauri 2 (`identifier`, `productName`) or Tauri 1 (`package`, `tauri.bundle`) shape. */
function tauriIdentity(parsed: TauriConfig | null): {
  identifier?: string;
  productName?: string;
  devUrl?: string;
} {
  const devUrl = text(parsed?.build?.devUrl) ?? text(parsed?.build?.devPath);
  return {
    identifier: text(parsed?.identifier) ?? text(parsed?.tauri?.bundle?.identifier),
    productName: text(parsed?.productName) ?? text(parsed?.package?.productName),
    devUrl: devUrl && /^https?:\/\//.test(devUrl) ? devUrl : undefined,
  };
}

async function detectTauri(
  root: string,
  deps: Record<string, string>,
): Promise<MonkeyDesktopApp | null> {
  const config = TAURI_CONFIGS.find((path) => existsSync(join(root, path)));
  const hasDependency = "@tauri-apps/api" in deps || "@tauri-apps/cli" in deps;
  if (!config && !hasDependency) return null;
  const identity = tauriIdentity(config ? await readTauriConfig(join(root, config)) : null);
  // tauri-driver wraps WebKitWebDriver on Linux and Edge WebDriver on Windows. macOS has
  // no WKWebView driver, so only an app-provided eval hook can drive it there.
  const drivers: MonkeyDesktopDriver[] =
    process.platform === "darwin" ? ["eval-hook"] : ["tauri-driver", "eval-hook"];
  return {
    framework: "tauri",
    config: config ?? "package.json",
    ...identity,
    realDataDirs: platformDataDirs(uniqueNames(identity.identifier, identity.productName)),
    drivers,
  };
}

function detectElectron(
  pkg: ElectronPackageJson | null,
  deps: Record<string, string>,
): MonkeyDesktopApp | null {
  if (!("electron" in deps)) return null;
  const identifier = text(pkg?.build?.appId);
  const productName = text(pkg?.build?.productName) ?? text(pkg?.productName) ?? text(pkg?.name);
  return {
    framework: "electron",
    config: "package.json",
    identifier,
    productName,
    realDataDirs: platformDataDirs(uniqueNames(productName, text(pkg?.name))),
    drivers: ["playwright-electron", "eval-hook"],
  };
}

export async function detectDesktopApp(
  root: string,
  pkg: MonkeyPackageJson | null,
): Promise<MonkeyDesktopApp | null> {
  const deps = allMonkeyDependencies(pkg);
  return (await detectTauri(root, deps)) ?? detectElectron(pkg as ElectronPackageJson | null, deps);
}

export function describeDesktopApp(app: MonkeyDesktopApp): string {
  const name = app.framework === "tauri" ? "Tauri" : "Electron";
  const identity = app.identifier ?? app.productName ?? "unnamed";
  return `${name} app ${identity} (${app.config}); drive with ${app.drivers.join(" or ")}`;
}

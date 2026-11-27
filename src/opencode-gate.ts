/**
 * Generated OpenCode install gate plugin. No single file loads in every OpenCode release, because
 * the loaders want different module shapes (repository sst/opencode):
 *
 * - 1.0 to 1.3 call every export as a plugin function: `for (const [_name, fn] of
 *   Object.entries(mod)) await fn(input)` (`packages/opencode/src/plugin/index.ts:41-44` at v1.0.0,
 *   commit b9a39b81; `:86-92` at v1.2.0, ffc000de; `:119-124` at v1.3.0, eb3bfffa). A default
 *   export that is an object makes that call throw, so these releases get the "v1" form: function
 *   exports only.
 * - 1.4 and later 1.x read `default.server` when the default export is an object with an `id`
 *   (`readV1Plugin`, `packages/opencode/src/plugin/shared.ts:272-303`, called from `index.ts:90` at
 *   v1.4.0, 98325dcd, and from `index.ts:114-125` at v1.19.6, f4e363c8).
 * - 2.x decodes `export default { id, setup }` or `{ id, effect }` and nothing else
 *   (`packages/core/src/plugin/module.ts:81-93` at 697db192, v2.4.1; "V1 plugin implementations do
 *   not run in V2", `services/site/src/docs/content/build/plugins/migrate-v1.mdx:10-12`). The
 *   decoder refuses a default export that is not an object (effect 4.1.0
 *   `packages/effect/src/SchemaAST.ts:3144`, commit 9a91b192), so a function with properties does
 *   not load there. It ignores the extra `server` key. `setup` registers
 *   `ctx.tool.hook("execute.before")`; the event is `{tool, input, ...}`
 *   (`packages/plugin/src/promise/tool.ts:51-61`), the shell tool is `shell` with `input.command`
 *   (`packages/core/src/tool/plugin/shell.ts:29,64-65`), and a rejection fails that call alone
 *   (`packages/plugin/src/promise/adapter.ts:265-282`).
 *
 * So 1.4 and later get the "both" form: `export default { id, setup, server }`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type OpenCodePluginApi = "v1" | "both";

/** The plugin form for an `opencode --version` output; undefined when it names no version. */
export function openCodePluginApi(version: string | undefined): OpenCodePluginApi | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return undefined;
  return Number(m[1]) === 1 && Number(m[2]) < 4 ? "v1" : "both";
}

/**
 * The version of the OpenCode on PATH, read without running anything from the project. Only
 * absolute PATH directories outside `projectRoot` count, so a repository cannot plant an
 * `opencode` that kit runs. The version comes from the package.json of the npm install the
 * binary belongs to; on macOS and Linux, when there is none, kit runs that absolute binary with
 * `--version`, without a shell and from the home directory. Undefined when there is no safe answer.
 */
export function detectOpenCodeVersion(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const bin = trustedOpenCodeBinary(projectRoot, env);
  if (!bin) return undefined;
  const fromPackage = installedPackageVersion(bin);
  if (fromPackage || process.platform === "win32") return fromPackage;
  try {
    return execFileSync(bin, ["--version"], {
      cwd: homedir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      shell: false,
    });
  } catch {
    return undefined;
  }
}

/** True when `child` is `root` or inside it, compared as real paths. */
function inside(child: string, root: string): boolean {
  const rel = relative(realOr(root), realOr(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The first `opencode` on PATH in an absolute directory outside the project. */
function trustedOpenCodeBinary(projectRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  const names = process.platform === "win32" ? ["opencode.cmd", "opencode.exe"] : ["opencode"];
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir) || inside(dir, projectRoot)) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
  }
  return undefined;
}

/**
 * The version in the package.json of the npm package that holds `bin`: the folder of the
 * resolved binary and its parents (macOS and Linux symlink into the package), or the
 * `node_modules/opencode-ai` next to a Windows npm shim.
 */
function installedPackageVersion(bin: string): string | undefined {
  const candidates = [join(dirname(bin), "node_modules", "opencode-ai", "package.json")];
  let dir = dirname(realOr(bin));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) candidates.push(join(dir, "package.json"));
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
      if (
        typeof pkg.name === "string" &&
        /opencode/.test(pkg.name) &&
        typeof pkg.version === "string"
      ) {
        return pkg.version;
      }
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/** True for a gate plugin with no default export: the form only OpenCode 1.x loads. */
export function isV1OnlyPlugin(text: string): boolean {
  return text.includes("tool.execute.before") && !/^export default\b/m.test(text);
}

const BOTH_HEADER =
  "// Loads in OpenCode 2.x (default export { id, setup }) and OpenCode 1.4+ (default export { id, server }).\n";
const V1_HEADER = "// For OpenCode 1.0 to 1.3, which call every export as a plugin function.\n";
const DEFAULT_EXPORT = `
export default {
  id: "kit-install-gate",
  // OpenCode 2.x: register the hook on the tool domain; one mutable event per call.
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => gate(event?.tool, event?.input?.command));
  },
  // OpenCode 1.4+: the same V1 plugin function.
  server: kitInstallGate,
};
`;

/** The plugin text: "both" for OpenCode 1.4 and later, "v1" for OpenCode 1.0 to 1.3. */
export function renderOpenCodeInstallGate(api: OpenCodePluginApi = "both"): string {
  const both = api === "both";
  return `// kit install-gate — blocks un-triaged package installs before they run.
// Generated by \`kit agent-config --install-gate\`. Delete this file to disable.
${both ? BOTH_HEADER : V1_HEADER}import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function gateArgv() {
  const wrapper = join(homedir(), ".kit", "bin", process.platform === "win32" ? "kit.cmd" : "kit");
  if (!existsSync(wrapper)) {
    throw new Error(
      "kit install-gate cannot start: hook wrapper missing: " + wrapper + "; run kit agent-config",
    );
  }
  return [wrapper, "gate-bash"];
}

// OpenCode 2.x names the shell tool \`shell\`; 1.x builds call it \`bash\`.
const SHELL_TOOLS = ["bash", "shell"];

function gate(tool, command) {
  if (!SHELL_TOOLS.includes(tool ?? "")) return;
  if (typeof command !== "string" || command === "") return;
  try {
    const gate = gateArgv();
    // Windows cannot execFile a .cmd file directly. Only the fixed, local
    // wrapper path enters cmd.exe; the pending tool command stays on stdin.
    const executable = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : gate[0];
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", '"' + '"' + gate[0] + '" gate-bash' + '"']
      : gate.slice(1);
    execFileSync(executable, args, {
      input: JSON.stringify({ tool_input: { command } }),
      stdio: ["pipe", "ignore", "pipe"],
      windowsVerbatimArguments: process.platform === "win32",
    });
  } catch (err) {
    // gate-bash exits 2 to deny — throw to block the tool call.
    const reason = err && err.stderr ? String(err.stderr).trim() : "untriaged install";
    throw new Error("kit install-gate blocked: " + reason, { cause: err });
  }
}

// OpenCode 1.x: the plugin function returns its hooks by name.
export const kitInstallGate = async () => ({
  "tool.execute.before": async (input, output) => gate(input?.tool, output?.args?.command),
});
${both ? DEFAULT_EXPORT : ""}`;
}

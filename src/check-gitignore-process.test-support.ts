import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTemp } from "./temp-cleanup.test-support.js";

type Mode = "delayed-parent" | "broken-pipe" | "unreadable" | "no-match" | "trace" | "timeout";

interface ProbeResult {
  helper: { missing?: string[]; error?: string };
  gate: { status: string; detail: string; didNotRun?: boolean };
  gateStatus: string;
  stdinErrors: string[];
  stderr: string[];
}

// Run each probe in a separate process. PATH, Git configuration and the process
// instrumentation must not affect another test or the user's configuration.
const WORKER = String.raw`
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
const [helperUrl, gateUrl, root, mode, marker] = process.argv.slice(2);
const original = cp.execFile;
const stdinErrors = [];
const stderr = [];
cp.execFile = (file, args, options, callback) => {
  const child = original(file, args, options, (error, stdout, diagnostics) => {
    if (diagnostics) stderr.push(diagnostics);
    callback(error, stdout, diagnostics);
  });
  child.stdin?.on("error", error => stdinErrors.push(error.code));
  if (args[0] === "check-ignore" && mode === "broken-pipe") {
    const closedMarker = process.env.KIT_TEST_STDIN_MARKER;
    const deadline = Date.now() + 2000;
    while (!existsSync(closedMarker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (!existsSync(closedMarker)) {
      child.kill();
      throw new Error("Git fixture did not close stdin");
    }
  } else if (args[0] === "check-ignore" && mode === "delayed-parent") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return child;
};
syncBuiltinESMExports();
const { checkEnvIgnoreProtection } = await import(helperUrl);
const { checkEnvGitignored, gateStatus } = await import(gateUrl);
let helper;
try {
  helper = { missing: (await checkEnvIgnoreProtection(root)).missingPatterns.map(x => x.pattern) };
} catch (error) {
  helper = { error: error.message };
}
// A distinct marker makes the second check wait for its own child.
if (mode === "broken-pipe") process.env.KIT_TEST_STDIN_MARKER = marker + ".gate";
const gate = await checkEnvGitignored(root);
console.log(JSON.stringify({ helper, gate, gateStatus: gateStatus(gate), stdinErrors, stderr }));
`;

export function gitignoreProcessProbe(mode: Mode): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), "kit-gitignore-process-"));
  const root = join(dir, "repo");
  const ignore = join(root, ".gitignore");
  try {
    for (const name of ["repo", "home", "bin", "xdg"]) mkdirSync(join(dir, name));
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: join(dir, "home"),
      XDG_CONFIG_HOME: join(dir, "xdg"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      KIT_AUDIT_ANCHOR: "0",
      KIT_NO_UPDATE_CHECK: "1",
      KIT_NO_DOWNLOAD: "1",
      TSX_DISABLE_CACHE: "1",
      KIT_TEST_REAL_GIT: realGit,
      KIT_TEST_NODE: process.execPath,
      KIT_TEST_STDIN_MARKER: join(dir, "stdin-closed"),
    };
    execFileSync(realGit, ["init", "-q", root], { env });
    writeFileSync(ignore, mode === "no-match" ? "# no rules\n" : ".env*\n");
    let checkIgnore = 'exec "$KIT_TEST_REAL_GIT" "$@"';
    if (mode === "broken-pipe") {
      checkIgnore = 'exec 0<&-\n: > "$KIT_TEST_STDIN_MARKER"\nexit 1';
    } else if (mode === "timeout") {
      // This process exits 1 on SIGTERM. The helper must still report a timeout.
      checkIgnore =
        'exec "$KIT_TEST_NODE" -e \'process.on("SIGTERM",()=>process.exit(1));setInterval(()=>{},1000)\'';
    }
    writeFileSync(
      join(dir, "bin/git"),
      `#!/bin/sh\nif [ "$1" = "check-ignore" ]; then\n${checkIgnore}\nfi\nexec "$KIT_TEST_REAL_GIT" "$@"\n`,
      { mode: 0o755 },
    );
    env.PATH = join(dir, "bin");
    if (mode === "unreadable") chmodSync(ignore, 0o000);
    if (mode === "trace") env.GIT_TRACE = "1";
    const worker = join(dir, "worker.mjs");
    writeFileSync(worker, WORKER);
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const loader = extension === "ts" ? ["--import", import.meta.resolve("tsx")] : [];
    const result = spawnSync(
      process.execPath,
      [
        ...loader,
        worker,
        new URL(`./check-gitignore.${extension}`, import.meta.url).href,
        new URL(`./check-security.${extension}`, import.meta.url).href,
        root,
        mode,
        env.KIT_TEST_STDIN_MARKER!,
      ],
      { cwd: root, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as ProbeResult;
  } finally {
    if (mode === "unreadable") chmodSync(ignore, 0o644);
    rmTemp(dir);
  }
}

/** Isolated Windows probe for PowerShell startup and private ACL handling. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { it } from "node:test";

it("compares temporary and Git worktree paths on Windows", (t) => {
  if (process.platform !== "win32") {
    t.skip("The probe requires Windows");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "kit-path-probe-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const expected = realpathSync(root);
    const returned = realpathSync(gitRoot);
    const sameFile = statSync(root).ino === statSync(gitRoot).ino;
    console.log(JSON.stringify({ original: root, gitRoot, expected, returned, sameFile }));
    assert.equal(expected.toLowerCase(), returned.toLowerCase());
    assert.equal(sameFile, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it(
  "compares Windows ACL handling across isolated process environments",
  { timeout: 150_000 },
  (t) => {
    if (process.platform !== "win32") {
      t.skip("The probe requires Windows");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "kit-acl-probe-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const appdata = join(home, "AppData", "Roaming");
      const localAppdata = join(home, "AppData", "Local");
      for (const path of [home, bin, appdata, localAppdata]) mkdirSync(path, { recursive: true });
      const mock = join(bin, "mock-gh.cjs");
      writeFileSync(mock, "// Isolated mock module for the ACL probe.\n");
      const reduced: NodeJS.ProcessEnv = {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        USERPROFILE: home,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
        TMP: home,
        TEMP: home,
        TMPDIR: home,
        NODE_OPTIONS: `--require=${JSON.stringify(mock)}`,
        KIT_AUDIT_ANCHOR_DIR: join(root, "anchor"),
        KIT_AUDIT_ANCHOR: "0",
        KIT_NON_INTERACTIVE: "1",
        KIT_NO_UPDATE_CHECK: "1",
        KIT_TEST_REMOTE_HEAD: "a".repeat(40),
      };
      const expanded: NodeJS.ProcessEnv = {
        ...reduced,
        WINDIR: process.env.WINDIR,
        SystemDrive: process.env.SystemDrive,
        ProgramData: process.env.ProgramData,
        PSModulePath: process.env.PSModulePath,
        USERDOMAIN: process.env.USERDOMAIN,
        USERNAME: process.env.USERNAME,
        APPDATA: appdata,
        LOCALAPPDATA: localAppdata,
      };
      const withoutPreload = { ...reduced };
      delete withoutPreload.NODE_OPTIONS;
      const powershell = join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const start = Date.now();
      const initial = spawnSync(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", "Write-Output PROBE"],
        {
          env: reduced,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      const results: { name: string; ok: boolean; durationMs: number; code: string }[] = [
        {
          name: "powershell-start",
          ok: initial.status === 0 && initial.stdout.trim() === "PROBE",
          durationMs: Date.now() - start,
          code: initial.error?.message ?? String(initial.status),
        },
      ];
      const moduleUrl = new URL("./utils/secure-perms.js", import.meta.url).href;
      const script = `import {secureFileStrict,privateFileIsControlled} from ${JSON.stringify(moduleUrl)}; try {secureFileStrict(process.argv[1]); if (!privateFileIsControlled(process.argv[1])) throw Error('ACL verification failed'); process.stdout.write('OK');} catch (e) {process.stderr.write(JSON.stringify({code:e.cause?.code ?? null, message:e.message})); process.exitCode=1;}`;
      for (const [name, env] of [
        ["reduced", reduced],
        ["without-preload", withoutPreload],
        ["expanded", expanded],
      ] as const) {
        const file = join(root, `${name}.txt`);
        writeFileSync(file, "fixture");
        const began = Date.now();
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, file], {
          env,
          encoding: "utf8",
          timeout: 35_000,
        });
        let code = result.error?.message ?? String(result.status);
        try {
          const failure = JSON.parse(result.stderr) as { code?: string; message?: string };
          code = failure.code ?? failure.message ?? code;
        } catch {
          /* Ignore non-JSON diagnostics. */
        }
        results.push({
          name,
          ok: result.status === 0 && result.stdout === "OK",
          durationMs: Date.now() - began,
          code,
        });
      }
      console.log(JSON.stringify(results));
      assert.deepEqual(
        results.filter((entry) => !entry.ok).map((entry) => entry.name),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

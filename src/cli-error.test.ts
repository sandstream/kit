import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, main } from "./cli.js";

describe("CLI unexpected-error boundary (RED-8)", () => {
  it("returns JSON failure and redacts opaque environment credentials", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cli-error-"));
    const priorCwd = process.cwd();
    const priorArgv = process.argv;
    const priorExitCode = process.exitCode;
    const priorCi = process.env.CI;
    const priorHide = process.env.KIT_HIDE_HOOK_SKIP_BANNER;
    const priorToken = process.env.TEST_TOKEN;
    const secret = "opaque" + "CliCredential1234567890";
    const stdout: string[] = [];
    const stderr: string[] = [];
    writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
    COMMANDS.__unexpected_error_fixture = () => {
      throw new Error(`upstream rejected credential ${secret}`);
    };
    t.mock.method(console, "log", (...args: unknown[]) => stdout.push(args.join(" ")));
    t.mock.method(console, "error", (...args: unknown[]) => stderr.push(args.join(" ")));
    try {
      process.chdir(dir);
      process.argv = [process.execPath, "kit", "__unexpected_error_fixture", "--json"];
      process.env.CI = "true";
      process.env.KIT_HIDE_HOOK_SKIP_BANNER = "1";
      process.env.TEST_TOKEN = secret;
      await main();
      assert.equal(process.exitCode, 1);
      assert.ok(!stdout.join("\n").includes(secret));
      assert.ok(!stderr.join("\n").includes(secret));
      assert.deepEqual(JSON.parse(stdout.at(-1) ?? ""), {
        ok: false,
        error: "upstream rejected credential [REDACTED]",
      });
    } finally {
      delete COMMANDS.__unexpected_error_fixture;
      process.chdir(priorCwd);
      process.argv = priorArgv;
      process.exitCode = priorExitCode;
      if (priorCi === undefined) delete process.env.CI;
      else process.env.CI = priorCi;
      if (priorHide === undefined) delete process.env.KIT_HIDE_HOOK_SKIP_BANNER;
      else process.env.KIT_HIDE_HOOK_SKIP_BANNER = priorHide;
      if (priorToken === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = priorToken;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

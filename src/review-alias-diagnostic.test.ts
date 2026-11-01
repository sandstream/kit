import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { sameIdentity } from "./utils/same-file.js";

const fixture = fileURLToPath(new URL("./review-receipt-process.test-support.js", import.meta.url));

for (const form of ["short", "case"]) {
  it(`recovers through alternate Windows ${form} spelling`, async (t) => {
    if (process.platform !== "win32") return t.skip("Windows path diagnostic");
    const dir = mkdtempSync(join(tmpdir(), "kit-alias-probe-"));
    const repo = join(dir, "Repo"),
      signals = join(dir, "signals"),
      anchor = join(dir, "anchor");
    mkdirSync(repo);
    mkdirSync(signals);
    const env = { ...process.env, KIT_AUDIT_ANCHOR_DIR: anchor };
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "commit",
          "--allow-empty",
          "-qm",
          "test",
        ],
        { cwd: repo },
      );
      const canonical = resolve(
        execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: repo,
          encoding: "utf8",
        }).trim(),
      );
      const alternative = form === "short" ? repo : canonical.toUpperCase();
      assert.ok(
        sameIdentity(
          statSync(canonical, { bigint: true }),
          statSync(alternative, { bigint: true }),
        ),
      );
      const child = spawn(process.execPath, [fixture, canonical, "crash-gate", signals], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let error = "";
      child.stderr?.on("data", (chunk) => (error += chunk.toString()));
      try {
        const deadline = Date.now() + 30000;
        while (!existsSync(join(signals, "crash-gate.barrier"))) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw Error(`fixture exited\n${error}`);
          if (Date.now() > deadline) throw Error(`fixture timed out\n${error}`);
          await new Promise((done) => setTimeout(done, 20));
        }
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        child.kill("SIGKILL");
        await exited;
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      const recordedRoot = canonical;
      const recoveryRoot = resolve(
        execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: alternative,
          encoding: "utf8",
        }).trim(),
      );
      const result = spawnSync(process.execPath, [fixture, alternative, "recover", signals], {
        env,
        encoding: "utf8",
        timeout: 60000,
      });
      console.log(
        JSON.stringify({
          form,
          alternativeDiffers: alternative !== canonical,
          gitRootsMatch: recordedRoot === recoveryRoot,
          status: result.status,
          stderr: result.stderr,
        }),
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

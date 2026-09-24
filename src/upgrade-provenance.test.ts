import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = join(root, "node_modules", "tsx", "dist", "loader.mjs");

describe("kit upgrade CLI lock provenance", () => {
  it("records measured version and installer instead of declared guesses", async () => {
    const project = mkdtempSync(join(tmpdir(), "kit-upgrade-provenance-"));
    const bin = join(project, "bin");
    mkdirSync(bin);
    writeFileSync(join(project, ".kit.toml"), 'version = 1\n[tools]\nwidget = "latest"\n');
    writeFileSync(join(bin, "widget"), '#!/bin/sh\necho "widget 9.8.7"\n');
    chmodSync(join(bin, "widget"), 0o755);

    try {
      await exec(
        process.execPath,
        ["--import", tsxLoader, join(root, "src", "cli.ts"), "upgrade"],
        {
          cwd: project,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            KIT_NO_UPDATE_CHECK: "1",
          },
        },
      );
      const lock = JSON.parse(readFileSync(join(project, ".kit", "cli-lock.json"), "utf8"));
      assert.equal(lock.tools.widget.version, "9.8.7");
      assert.equal(lock.tools.widget.source, "manual");
      assert.equal(lock.tools.widget.sourceDetail, "unknown");
      assert.equal(lock.tools.widget.path, undefined);
      assert.ok(
        !readFileSync(join(project, ".kit", "cli-lock.json"), "utf8").includes(project),
        "committed locks must not contain machine-specific absolute paths",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

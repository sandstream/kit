import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceMode = import.meta.url.endsWith(".ts");
const cli = join(root, sourceMode ? "src" : "dist", sourceMode ? "cli.ts" : "cli.js");
const cliArgs = sourceMode ? ["--import", import.meta.resolve("tsx"), cli] : [cli];

describe("kit upgrade CLI lock provenance", () => {
  it("records measured version and installer instead of declared guesses", async () => {
    const project = mkdtempSync(join(tmpdir(), "kit-upgrade-provenance-"));
    const bin = join(project, "bin");
    mkdirSync(bin);
    writeFileSync(join(project, ".kit.toml"), 'version = 1\n[tools]\nwidget = "latest"\n');
    let fixtureNodeOptions: string | undefined;
    const fixtureEnv: NodeJS.ProcessEnv = {};
    if (process.platform === "win32") {
      // A bare Node alias treats --version as a Node runtime flag and exits before
      // userland preload hooks can answer it. Fake mise's `current` and `which`
      // commands instead, keeping this fixture shell-free on native Windows.
      const executable = join(bin, "widget.exe");
      try {
        linkSync(process.execPath, executable);
      } catch {
        copyFileSync(process.execPath, executable);
      }
      const mise = join(bin, "mise.exe");
      try {
        linkSync(process.execPath, mise);
      } catch {
        copyFileSync(process.execPath, mise);
      }
      const loader = join(bin, "fixture-loader.mjs");
      writeFileSync(
        loader,
        'if (process.argv[1] === "current" && process.argv[2] === "widget") {\n' +
          '  console.log("9.8.7");\n' +
          "  process.exit(0);\n" +
          "}\n" +
          'if (process.argv[1] === "which" && process.argv[2] === "widget") {\n' +
          "  console.log(process.env.WIDGET_FIXTURE_BIN);\n" +
          "  process.exit(0);\n" +
          "}\n",
      );
      fixtureNodeOptions = `--import=${pathToFileURL(loader).href}`;
      fixtureEnv.WIDGET_FIXTURE_BIN = executable;
    } else {
      writeFileSync(join(bin, "widget"), '#!/bin/sh\necho "widget 9.8.7"\n');
      chmodSync(join(bin, "widget"), 0o755);
    }

    try {
      await exec(process.execPath, [...cliArgs, "upgrade"], {
        cwd: project,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          ...(fixtureNodeOptions ? { NODE_OPTIONS: fixtureNodeOptions } : {}),
          ...fixtureEnv,
          KIT_NO_UPDATE_CHECK: "1",
        },
      });
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

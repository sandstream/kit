import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import { pipNormalise, requirementFileValues } from "./install-gate-requirements.js";
import { TRIAGE_LOG_FILE } from "./triage-receipt.js";

const made: string[] = [];
function project(requirements: string, file = "requirements.txt"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-req-")));
  made.push(dir);
  writeFileSync(join(dir, file), requirements);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function receipt(dir: string, target: string, ageDays = 0): void {
  const timestamp = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  const line = JSON.stringify({ timestamp, type: "pip", target, sandbox: false, granter: "t" });
  writeFileSync(join(dir, TRIAGE_LOG_FILE), line + "\n", { flag: "a" });
}

const REQS = "examplepkg-neutral==1.0.0\nexamplepkg-other>=2 --hash=sha256:00\n";

describe("pip install -r of a requirements file that no commit gate covers", () => {
  it("is blocked like a bare npm install until every requirement has a fresh receipt", async () => {
    const dir = project(REQS);
    const verdict = await decideBashGate("pip install -r requirements.txt", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /^bare install in .*: no fresh triage receipt \(7 days\) for/);
    assert.match(verdict.reason, /examplepkg-neutral, examplepkg-other/);
    assert.match(verdict.reason, /kit triage pip examplepkg-neutral examplepkg-other/);
  });

  it("covers the other spellings of the same pip install", async () => {
    const dir = project(REQS);
    for (const command of [
      "pip3 install --requirement requirements.txt",
      "pip install --requirement=requirements.txt",
      "pip install -rrequirements.txt",
      "python -m pip install -r requirements.txt",
      "uv pip install -r requirements.txt",
      `cd ${dir.replace(/\\/g, "/")} && pip install -r requirements.txt`,
    ]) {
      assert.equal((await decideBashGate(command, undefined, dir)).block, true, command);
    }
  });

  it("passes once every requirement has a fresh receipt, matching names as PyPI does", async () => {
    const dir = project(REQS);
    receipt(dir, "Examplepkg_Neutral");
    receipt(dir, "examplepkg-other==2.1");
    assert.equal(
      (await decideBashGate("pip install -r requirements.txt", undefined, dir)).block,
      false,
    );
  });

  it("names only the requirements that lack a fresh receipt", async () => {
    const dir = project(REQS);
    receipt(dir, "examplepkg-neutral");
    receipt(dir, "examplepkg-other", 30);
    const verdict = await decideBashGate("pip install -r requirements.txt", undefined, dir);
    assert.equal(verdict.block, true);
    assert.doesNotMatch(verdict.reason, /examplepkg-neutral/);
    assert.match(verdict.reason, /examplepkg-other/);
  });
});

describe("pip install -r: what the file says", () => {
  it("refuses what a name receipt cannot cover", async () => {
    for (const line of [
      "--index-url https://packages.example.invalid/simple",
      "--extra-index-url https://packages.example.invalid/simple",
      "-r other.txt",
      "-e git+https://git.example.invalid/examplepkg-neutral",
      "examplepkg-neutral @ https://files.example.invalid/x.whl",
      "https://files.example.invalid/x.whl",
    ]) {
      const dir = project(`${line}\n`);
      receipt(dir, "examplepkg-neutral");
      const verdict = await decideBashGate("pip install -r requirements.txt", undefined, dir);
      assert.equal(verdict.block, true, line);
      assert.match(verdict.reason, /cannot triage .*\(fail-closed\)/, line);
    }
  });

  it("reads comments, continuations, extras, markers and harmless options", async () => {
    const dir = project(
      "# a comment\n--prefer-binary\nexamplepkg-neutral[extra] == 1.0 ; python_version > '3' \\\n  --hash=sha256:00\n\n./local-dir\n",
    );
    receipt(dir, "examplepkg-neutral");
    assert.equal(
      (await decideBashGate("pip install -r requirements.txt", undefined, dir)).block,
      false,
    );
  });

  it("refuses a requirements path the shell would expand", async () => {
    const dir = project(REQS);
    const verdict = await decideBashGate("pip install -r $REQS", undefined, dir);
    assert.equal(verdict.block, true);
  });
});

describe("pip install -r that stays allowed", () => {
  it("allows a requirements file that git tracks, because check-deps gates it at commit", async () => {
    const dir = project(REQS);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "requirements.txt"], { cwd: dir });
    assert.equal(
      (await decideBashGate("pip install -r requirements.txt", undefined, dir)).block,
      false,
    );
  });

  it("allows a file that does not exist (pip fails on its own) and a call with no directory", async () => {
    const dir = project(REQS);
    assert.equal((await decideBashGate("pip install -r missing.txt", undefined, dir)).block, false);
    assert.equal((await decideBashGate("pip install -r requirements.txt")).block, false);
  });

  it("does not read an untracked package.json for a pip install", async () => {
    const dir = project("");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "examplepkg-neutral": "1" } }),
    );
    assert.equal(
      (await decideBashGate("pip install -r requirements.txt", undefined, dir)).block,
      false,
    );
  });
});

describe("requirement file parsing helpers", () => {
  it("finds every requirement file value and only pip-family installs record them", () => {
    assert.deepEqual(
      requirementFileValues([
        "pip",
        "install",
        "-r",
        "a.txt",
        "-rb.txt",
        "--requirement=c.txt",
        "-r",
      ]),
      ["a.txt", "b.txt", "c.txt", undefined],
    );
    assert.equal(parseInstallCommand("pip install -r a.txt").requirementSegments.length, 1);
    assert.equal(parseInstallCommand("npm install -r a.txt").requirementSegments.length, 0);
    assert.equal(pipNormalise("Example_Pkg.Neutral"), "example-pkg-neutral");
  });
});

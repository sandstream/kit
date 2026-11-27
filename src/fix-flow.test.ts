/**
 * Characterization of the `kit fix` pipeline output and exit value, step by step.
 *
 * `fix-cwd.test.ts` pins WHERE `cmdFix` writes. This file pins WHAT it prints and returns for each
 * of the six steps, the deploy step and the summary, so the function can be split into helpers
 * without a change in behavior. Every assertion below passed on the code before the split.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { cmdFix } from "./fix.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const SECRETS =
  '\n[secrets]\nstore = "env"\ntemplate = ".env.template"\n\n[secrets.keys.API_KEY]\nsource = "env"\n';

function project(extra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-fix-flow-"));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".kit.toml"), `version = 1\n${extra}`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "f", version: "1.0.0", private: true }) + "\n",
  );
  return dir;
}

/** Run `cmdFix(dir)` with an isolated identity dir and read-only mode off; return text and value. */
async function runFix(
  dir: string,
  env: Record<string, string> = {},
): Promise<{ out: string; ok: boolean }> {
  const idDir = mkdtempSync(join(tmpdir(), "kit-fix-flow-id-"));
  const saved: Record<string, string | undefined> = {};
  // The mise variables keep `kit fix` off this machine's real mise config and data folder.
  const vars = {
    KIT_IDENTITY_DIR: idDir,
    MISE_GLOBAL_CONFIG_FILE: join(idDir, "no-global-mise.toml"),
    MISE_DATA_DIR: join(idDir, "mise-data"),
    ...env,
  };
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const prevLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    const ok = await cmdFix(dir);
    return { out: stripVTControlCharacters(lines.join("\n")), ok };
  } finally {
    console.log = prevLog;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmTemp(idDir);
  }
}

function useFixture(extra = ""): { dir: () => string; cleanup: () => void } {
  const dirs: string[] = [];
  return {
    dir: () => {
      const d = project(extra);
      dirs.push(d);
      return d;
    },
    cleanup: () => dirs.forEach(rmTemp),
  };
}

describe("cmdFix steps 1 and 2: header, tools, lock files", () => {
  it("prints the six step headings in order and generates both lock files", async () => {
    const f = useFixture();
    try {
      const dir = f.dir();
      const { out, ok } = await runFix(dir);
      const headings = ["kit fix", "[2/6] Lock Files", "[3/6] Services", "[4/6] Secrets Template"];
      let at = -1;
      for (const h of [...headings, "[5/6] .gitignore", "[6/6] Git Hooks", "Summary"]) {
        const next = out.indexOf(h);
        assert.ok(next > at, `${h} must come after the previous heading`);
        at = next;
      }
      assert.doesNotMatch(out, /\[1\/6\] Tools/, "no [tools] means no step 1 heading");
      assert.match(out, /Generated skills-lock\.json/);
      assert.match(out, /Generated cli-lock\.json/);
      assert.match(out, /Fixed \d+ issue\(s\) automatically/);
      assert.equal(ok, true);
    } finally {
      f.cleanup();
    }
  });

  it("a second run reports existing lock files and nothing to fix", async () => {
    const f = useFixture();
    try {
      const dir = f.dir();
      await runFix(dir);
      const { out, ok } = await runFix(dir);
      assert.match(out, /Lock files exist/);
      assert.match(out, /No services configured/);
      assert.match(out, /No secrets template configured/);
      assert.match(out, /\.gitignore already hardened/);
      assert.match(out, /No hooks configured in \.kit\.toml/);
      assert.match(out, /Nothing to fix/);
      assert.equal(ok, true);
    } finally {
      f.cleanup();
    }
  });

  it("generates only the skills lock when the cli lock already exists", async () => {
    const f = useFixture();
    try {
      const dir = f.dir();
      mkdirSync(join(dir, ".kit"), { recursive: true });
      writeFileSync(join(dir, ".kit", "cli-lock.json"), '{"version":1,"tools":{}}\n');
      const { out } = await runFix(dir);
      assert.match(out, /Generating missing lock files/);
      assert.match(out, /Generated skills-lock\.json/);
      assert.doesNotMatch(out, /Generated cli-lock\.json/);
      assert.equal(existsSync(join(dir, ".kit", "skills-lock.json")), true);
    } finally {
      f.cleanup();
    }
  });

  it("merges required and optional skills into the generated skills lock", async () => {
    const f = useFixture(
      '\n[skills.required]\nalpha = "1.0.0"\n\n[skills.optional]\nbeta = "2.0.0"\n',
    );
    try {
      const dir = f.dir();
      await runFix(dir);
      const lock = readFileSync(join(dir, ".kit", "skills-lock.json"), "utf-8");
      assert.match(lock, /alpha/);
      assert.match(lock, /beta/);
    } finally {
      f.cleanup();
    }
  });
});

describe("cmdFix step 3: services", () => {
  it("lists an unauthenticated service, raises a manual action and returns false", async () => {
    const f = useFixture(
      '\n[services.vault]\nlogin = "vault login"\ncheck = "node -e process.exit(1)"\n',
    );
    try {
      const { out, ok } = await runFix(f.dir());
      assert.match(out, /1 service\(s\) require manual authentication/);
      assert.match(out, /vault\s+not authenticated/);
      assert.match(out, /1 issue\(s\) require human action/);
      assert.match(out, /HITL required/);
      assert.match(out, /Run kit check to verify status after manual fixes/);
      assert.equal(ok, false);
    } finally {
      f.cleanup();
    }
  });

  it("reports all services authenticated when the check passes", async () => {
    const f = useFixture('\n[services.vault]\nlogin = ""\ncheck = "node -e 0"\n');
    try {
      const { out, ok } = await runFix(f.dir());
      assert.match(out, /All services authenticated/);
      assert.equal(ok, true);
    } finally {
      f.cleanup();
    }
  });
});

describe("cmdFix step 4: secrets template", () => {
  it("generates the template with the key count, then reports that it exists", async () => {
    const f = useFixture(SECRETS);
    try {
      const dir = f.dir();
      const first = await runFix(dir);
      assert.match(first.out, /Generated .*\.env\.template\s+\(1 keys\)/);
      const second = await runFix(dir);
      assert.match(second.out, /Template .*\.env\.template exists/);
    } finally {
      f.cleanup();
    }
  });

  it("a template path that cannot be created becomes a manual action", async () => {
    const f = useFixture(SECRETS.replace('".env.template"', '"blocked/.env.template"'));
    try {
      const dir = f.dir();
      // A file where the template's parent directory belongs makes the create fail.
      writeFileSync(join(dir, "blocked"), "not a directory\n");
      const { out, ok } = await runFix(dir);
      assert.match(out, /✗ Failed to write .*\.env\.template/);
      assert.match(out, /Blocker: .*\.env\.template could not be created/);
      assert.match(out, /Add 1 key placeholder\(s\)\./);
      assert.equal(ok, false);
    } finally {
      f.cleanup();
    }
  });
});

describe("cmdFix step 5: .gitignore", () => {
  it("reports the repair when the file needs patching", async () => {
    const f = useFixture();
    try {
      const dir = f.dir();
      writeFileSync(join(dir, ".gitignore"), "node_modules\n");
      const { out } = await runFix(dir);
      assert.match(out, /Repaired \.gitignore protection and verified with Git/);
    } finally {
      f.cleanup();
    }
  });

  it("a tracked secret file becomes a manual action", async () => {
    const f = useFixture();
    try {
      const dir = f.dir();
      await runFix(dir);
      writeFileSync(join(dir, ".env.keys"), "fixture only\n");
      execFileSync("git", ["add", "-f", "--", ".env.keys"], { cwd: dir });
      const { out, ok } = await runFix(dir);
      assert.match(out, /✗ \.gitignore harden failed: .*already tracked/);
      assert.match(out, /Blocker: \.gitignore could not be hardened/);
      assert.equal(ok, false);
    } finally {
      f.cleanup();
    }
  });
});

describe("cmdFix step 6: git hooks", () => {
  const HOOKS = '\n[hooks]\npre-commit = ["echo hi"]\n';

  it("installs a configured hook and counts it as fixed", async () => {
    const f = useFixture(HOOKS);
    try {
      const dir = f.dir();
      const { out, ok } = await runFix(dir);
      assert.match(out, /Installed 1 hook\(s\): pre-commit/);
      assert.equal(existsSync(join(dir, ".git", "hooks", "pre-commit")), true);
      assert.equal(ok, true);
    } finally {
      f.cleanup();
    }
  });

  it("leaves an existing non-kit hook alone and raises a manual action", async () => {
    const f = useFixture(HOOKS);
    try {
      const dir = f.dir();
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const { out, ok } = await runFix(dir);
      assert.match(out, /! pre-commit: /);
      assert.match(out, /Blocker: pre-commit hook was left untouched/);
      assert.equal(ok, false);
    } finally {
      f.cleanup();
    }
  });

  it("a second run does not install the hook again", async () => {
    const f = useFixture(HOOKS);
    try {
      const dir = f.dir();
      await runFix(dir);
      const { out, ok } = await runFix(dir);
      assert.doesNotMatch(out, /Installed 1 hook\(s\)/);
      assert.equal(ok, true);
    } finally {
      f.cleanup();
    }
  });

  it("an unusable hooks directory is reported as a failure", async () => {
    const f = useFixture(HOOKS);
    try {
      const dir = f.dir();
      // A file where the hooks directory belongs makes the install fail for this hook.
      rmSync(join(dir, ".git", "hooks"), { recursive: true, force: true });
      writeFileSync(join(dir, ".git", "hooks"), "not a directory\n");
      const { out, ok } = await runFix(dir);
      assert.match(out, /✗ hooks-dir: Failed to create hooks directory/);
      assert.match(out, /Blocker: hooks-dir hook could not be installed/);
      assert.equal(ok, false);
    } finally {
      f.cleanup();
    }
  });
});

describe("cmdFix read-only mode and the deploy step", () => {
  it("refuses the whole pipeline in read-only mode and writes nothing", async () => {
    const f = useFixture();
    try {
      const dir = f.dir();
      const { out, ok } = await runFix(dir, { KIT_READ_ONLY: "1" });
      assert.equal(ok, false);
      assert.doesNotMatch(out, /\[2\/6\] Lock Files/);
      assert.equal(existsSync(join(dir, ".kit", "skills-lock.json")), false);
    } finally {
      f.cleanup();
    }
  });

  it("without [deploy] the pipeline prints no deploy section", async () => {
    const f = useFixture();
    try {
      const { out } = await runFix(f.dir());
      assert.doesNotMatch(out, /\[deploy\] Deploy Env/);
    } finally {
      f.cleanup();
    }
  });
});

describe("cmdFix pins npm: tools a mise config holds at latest (fork loop)", () => {
  it(
    "rewrites the project's mise.toml to the installed version and counts it as fixed",
    { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false },
    async () => {
      const f = useFixture();
      const dir = f.dir();
      const machine = mkdtempSync(join(tmpdir(), "kit-fix-flow-mise-"));
      try {
        const data = join(machine, "data");
        mkdirSync(join(data, "shims"), { recursive: true });
        mkdirSync(join(data, "installs", "npm-snyk", "1.1305.1"), { recursive: true });
        writeFileSync(join(machine, "mise"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        symlinkSync(join(machine, "mise"), join(data, "shims", "npm"));
        writeFileSync(join(dir, "mise.toml"), '[tools]\n"npm:snyk" = "latest"\n');
        const { out } = await runFix(dir, {
          MISE_DATA_DIR: data,
          PATH: [join(data, "shims"), process.env.PATH ?? ""].join(delimiter),
        });
        assert.match(out, /npm:snyk\s+pinned\s+latest → 1\.1305\.1/);
        assert.equal(
          readFileSync(join(dir, "mise.toml"), "utf8"),
          '[tools]\n"npm:snyk" = "1.1305.1"\n',
        );
      } finally {
        rmSync(machine, { recursive: true, force: true });
        f.cleanup();
      }
    },
  );
});

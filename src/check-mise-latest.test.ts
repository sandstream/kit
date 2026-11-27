import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  checkMiseLatest,
  globalMiseConfig,
  installedMiseVersion,
  latestNpmTools,
  pinMiseLatest,
  type MiseLatestEnv,
} from "./check-mise-latest.js";

/**
 * A fake machine in a temp folder: home, a mise data dir with installs and shims, a global config.
 * Nothing here runs mise or npm; the check only reads files.
 */
function machine(opts: { shim: boolean; global?: string; project?: string }) {
  const root = mkdtempSync(join(tmpdir(), "kit-mise-latest-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const data = join(root, "data");
  const shims = join(data, "shims");
  const bin = join(root, "bin");
  for (const d of [home, project, shims, bin]) mkdirSync(d, { recursive: true });
  const fakeMise = join(root, "mise");
  writeFileSync(fakeMise, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (opts.shim) symlinkSync(fakeMise, join(shims, "npm"));
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // Installed versions: a real dir per version and mise's alias symlinks beside it.
  for (const [tool, versions] of [
    ["npm-snyk", ["1.1305.1", "1.1290.0"]],
    ["npm-socketsecurity-cli", ["1.1.102"]],
  ] as const) {
    for (const v of versions) mkdirSync(join(data, "installs", tool, v), { recursive: true });
    symlinkSync(join(data, "installs", tool, versions[0]), join(data, "installs", tool, "latest"));
  }
  const globalFile = join(root, "config", "mise", "config.toml");
  mkdirSync(join(root, "config", "mise"), { recursive: true });
  if (opts.global) writeFileSync(globalFile, opts.global);
  if (opts.project) writeFileSync(join(project, "mise.toml"), opts.project);
  const env: MiseLatestEnv = {
    env: {
      PATH: opts.shim ? [shims, bin].join(delimiter) : [bin, shims].join(delimiter),
      MISE_DATA_DIR: data,
      MISE_GLOBAL_CONFIG_FILE: globalFile,
    },
    home,
    platform: "linux",
  };
  return {
    root,
    home,
    project,
    globalFile,
    env,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const BAD_GLOBAL = `[tools]
node = "22"
"npm:snyk" = "latest" # scanner
"npm:@socketsecurity/cli" = "latest"
"pipx:semgrep" = "latest"
`;

// Symbolic links need privileges on Windows; the shim detection there is by folder, not by link.
const posixOnly = {
  skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false,
};

describe("mise config with npm: tools at latest (fork-loop risk)", () => {
  it("reads the global config path from mise's own variables", () => {
    assert.equal(globalMiseConfig({ MISE_GLOBAL_CONFIG_FILE: "/x/c.toml" }, "/h"), "/x/c.toml");
    assert.equal(globalMiseConfig({ MISE_CONFIG_DIR: "/m" }, "/h"), join("/m", "config.toml"));
    assert.equal(
      globalMiseConfig({ XDG_CONFIG_HOME: "/x" }, "/h"),
      join("/x", "mise", "config.toml"),
    );
    assert.equal(globalMiseConfig({}, "/h"), join("/h", ".config", "mise", "config.toml"));
  });

  it("finds npm: tools at latest in string, table and list forms, and ignores pipx:", () => {
    const found = latestNpmTools(
      `[tools]\n"npm:a" = "latest"\n"npm:b" = { version = "latest" }\n"npm:c" = ["latest"]\n"npm:d" = "1.0.0"\n"pipx:e" = "latest"\n`,
    );
    assert.deepEqual(found, ["npm:a", "npm:b", "npm:c"]);
    assert.deepEqual(latestNpmTools("not = [valid"), []);
  });

  it(
    "reads the installed version from mise's install folder, skipping alias links",
    posixOnly,
    () => {
      const m = machine({ shim: true });
      try {
        const data = m.env.env.MISE_DATA_DIR!;
        assert.equal(installedMiseVersion(data, "npm:snyk"), "1.1305.1");
        assert.equal(installedMiseVersion(data, "npm:@socketsecurity/cli"), "1.1.102");
        assert.equal(installedMiseVersion(data, "npm:never-installed"), null);
      } finally {
        m.done();
      }
    },
  );
});

describe("the mise npm: latest row", () => {
  it(
    "warns when a config has npm: at latest and npm on PATH is a mise shim",
    posixOnly,
    async () => {
      const m = machine({ shim: true, global: BAD_GLOBAL });
      try {
        const [row] = checkMiseLatest(m.project, m.env);
        assert.equal(row.status, "warn");
        assert.equal(row.category, "supply-chain");
        assert.equal(row.severity, "high");
        assert.match(row.detail, /npm:snyk/);
        assert.match(row.detail, /npm:@socketsecurity\/cli/);
        assert.doesNotMatch(row.detail, /pipx:semgrep/);
        assert.match(row.detail, /npm view/);
        assert.match(row.detail, /shim/);
        assert.match(row.suggestion ?? "", /kit fix/);
        // The heal recipe keys on "mise use <ref>"; this row must not trigger an install.
        assert.doesNotMatch(row.suggestion ?? "", /mise use /);
      } finally {
        m.done();
      }
    },
  );

  it("checks the project's mise.toml too", posixOnly, () => {
    const m = machine({ shim: true, project: `[tools]\n"npm:snyk" = "latest"\n` });
    try {
      const [row] = checkMiseLatest(m.project, m.env);
      assert.equal(row.status, "warn");
      assert.match(row.detail, /mise\.toml/);
    } finally {
      m.done();
    }
  });

  it(
    "warns even when a real npm comes first on kit's own PATH (kit runs under mise's node)",
    posixOnly,
    () => {
      const m = machine({ shim: true, global: BAD_GLOBAL });
      try {
        const shims = join(m.env.env.MISE_DATA_DIR!, "shims");
        const realFirst = [join(m.root, "bin"), shims].join(delimiter);
        const [row] = checkMiseLatest(m.project, {
          ...m.env,
          env: { ...m.env.env, PATH: realFirst },
        });
        assert.equal(row.status, "warn");
      } finally {
        m.done();
      }
    },
  );

  it("passes when mise's shims folder is not on PATH", posixOnly, () => {
    const m = machine({ shim: true, global: BAD_GLOBAL });
    try {
      const noShims = { ...m.env, env: { ...m.env.env, PATH: join(m.root, "bin") } };
      const [row] = checkMiseLatest(m.project, noShims);
      assert.equal(row.status, "pass");
    } finally {
      m.done();
    }
  });

  it("passes when mise has no npm shim", posixOnly, () => {
    const m = machine({ shim: false, global: BAD_GLOBAL });
    try {
      const [row] = checkMiseLatest(m.project, m.env);
      assert.equal(row.status, "pass");
      assert.match(row.detail, /no npm shim on PATH/);
    } finally {
      m.done();
    }
  });

  it("passes when nothing is at latest", posixOnly, () => {
    const m = machine({ shim: true, global: `[tools]\n"npm:snyk" = "1.1305.1"\n` });
    try {
      const [row] = checkMiseLatest(m.project, m.env);
      assert.equal(row.status, "pass");
    } finally {
      m.done();
    }
  });
});

describe("pinMiseLatest (kit fix migration)", () => {
  it(
    "pins each npm: latest to the installed version and keeps the rest of the file",
    posixOnly,
    async () => {
      const m = machine({ shim: true, global: BAD_GLOBAL });
      try {
        const out = await pinMiseLatest(m.project, m.env);
        assert.deepEqual(
          out.map((o) => [o.tool, "to" in o ? o.to : o.reason]),
          [
            ["npm:snyk", "1.1305.1"],
            ["npm:@socketsecurity/cli", "1.1.102"],
          ],
        );
        const text = readFileSync(m.globalFile, "utf8");
        assert.match(text, /^"npm:snyk" = "1\.1305\.1" # scanner$/m);
        assert.match(text, /^"npm:@socketsecurity\/cli" = "1\.1\.102"$/m);
        assert.match(text, /^"pipx:semgrep" = "latest"$/m);
        assert.match(text, /^node = "22"$/m);
        const [row] = checkMiseLatest(m.project, m.env);
        assert.equal(row.status, "pass");
      } finally {
        m.done();
      }
    },
  );

  it("does not pin what is not installed, and says how to pin it by hand", posixOnly, async () => {
    const m = machine({ shim: true, global: `[tools]\n"npm:never-installed" = "latest"\n` });
    try {
      const [o] = await pinMiseLatest(m.project, m.env);
      assert.ok("reason" in o);
      assert.match("reason" in o ? o.reason : "", /not installed/);
      assert.match(readFileSync(m.globalFile, "utf8"), /"latest"/);
    } finally {
      m.done();
    }
  });

  it("refuses in read-only mode and writes nothing", posixOnly, async () => {
    const m = machine({ shim: true, global: BAD_GLOBAL });
    process.env.KIT_READ_ONLY = "1";
    try {
      const out = await pinMiseLatest(m.project, m.env);
      assert.equal(out.length, 1);
      assert.match("reason" in out[0] ? out[0].reason : "", /read-only/);
      assert.equal(readFileSync(m.globalFile, "utf8"), BAD_GLOBAL);
    } finally {
      delete process.env.KIT_READ_ONLY;
      m.done();
    }
  });
});

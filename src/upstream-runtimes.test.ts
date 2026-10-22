import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  decideRuntime,
  detectRuntimes,
  parseVersionOutput,
  resolveBinary,
  RUNTIME_SPECS,
} from "./upstream-runtimes.js";
import type { ReleaseInfo } from "./upstream-sources.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const spec = (id: string) => RUNTIME_SPECS.find((s) => s.id === id)!;

function release(tag: string, body = "", extra: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tag,
    version: null,
    name: tag,
    body,
    url: `https://example.test/${tag}`,
    prerelease: false,
    publishedAt: "d",
    ...extra,
  };
}

describe("parseVersionOutput", () => {
  it("reads the version out of each interpreter's own output", () => {
    assert.equal(parseVersionOutput("v22.23.3\n"), "22.23.3");
    assert.equal(
      parseVersionOutput(
        "PHP 8.5.6 (cli) (built: May  5 2026 21:19:36) (NTS)\nCopyright (c) The PHP Group",
      ),
      "8.5.6",
    );
    assert.equal(parseVersionOutput("Python 3.9.6\n"), "3.9.6");
  });

  it("returns null for output that holds no version", () => {
    assert.equal(parseVersionOutput("command not found"), null);
    assert.equal(parseVersionOutput(""), null);
  });
});

function inDir(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kit-runtimes-"));
  try {
    for (const [f, text] of Object.entries(files)) {
      const full = join(dir, f);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    body(dir);
  } finally {
    rmTemp(dir);
  }
}
const byId = (dir: string) => Object.fromEntries(detectRuntimes(dir).map((r) => [r.id, r]));

describe("detectRuntimes", () => {
  it("finds nothing in a directory with no runtime signal", () =>
    inDir({}, (dir) => assert.deepEqual(detectRuntimes(dir), [])));

  it("detects node from package.json and reads engines.node as the declared version", () =>
    inDir({ "package.json": JSON.stringify({ engines: { node: ">=22.0.0" } }) }, (dir) => {
      assert.equal(byId(dir).node.declared, ">=22.0.0");
      assert.equal(byId(dir).node.declaredFrom, "package.json engines.node");
    }));

  it("prefers .nvmrc over .node-version, .tool-versions and mise.toml", () =>
    inDir(
      {
        ".nvmrc": "v22.1.0\n",
        ".node-version": "20\n",
        ".tool-versions": "nodejs 18.0.0\n",
        "mise.toml": '[tools]\nnode = "16"\n',
      },
      (dir) => {
        assert.equal(byId(dir).node.declared, "22.1.0");
        assert.equal(byId(dir).node.declaredFrom, ".nvmrc");
      },
    ));

  it("reads .tool-versions for node, php and python", () =>
    inDir({ ".tool-versions": "nodejs 22.9.0\nphp 8.3.1\npython 3.12.3\nruby 3.3.0\n" }, (dir) => {
      const r = byId(dir);
      assert.deepEqual(
        [r.node.declared, r.php.declared, r.python.declared],
        ["22.9.0", "8.3.1", "3.12.3"],
      );
      assert.equal(r.ruby, undefined);
    }));
});

describe("detectRuntimes sources and untrusted files", () => {
  it("reads mise.toml string, array and table forms", () =>
    inDir(
      {
        "mise.toml": '[tools]\nnode = "22"\nphp = ["8.3", "8.2"]\npython = { version = "3.12" }\n',
      },
      (dir) => {
        const r = byId(dir);
        assert.deepEqual(
          [r.node.declared, r.php.declared, r.python.declared],
          ["22", "8.3", "3.12"],
        );
      },
    ));

  it("detects php from composer.json and python from pyproject.toml and requirements.txt", () =>
    inDir(
      {
        "composer.json": JSON.stringify({ require: { php: ">=8.2" } }),
        "pyproject.toml": '[project]\nrequires-python = ">=3.11"\n',
      },
      (dir) => {
        const r = byId(dir);
        assert.equal(r.php.declared, ">=8.2");
        assert.equal(r.python.declared, ">=3.11");
      },
    ));

  it("detects python from requirements.txt alone, with no declared version", () =>
    inDir({ "requirements.txt": "requests\n" }, (dir) => {
      assert.equal(byId(dir).python.declared, null);
    }));

  it("reads .python-version", () =>
    inDir({ ".python-version": "3.12.3\n" }, (dir) =>
      assert.equal(byId(dir).python.declared, "3.12.3"),
    ));

  it("refuses a symlinked version file and never echoes the file it points at", () =>
    inDir({ "secret.txt": "TOP-SECRET-VALUE", "package.json": "{}" }, (dir) => {
      symlinkSync(join(dir, "secret.txt"), join(dir, ".nvmrc"));
      const text = JSON.stringify(detectRuntimes(dir));
      assert.ok(!text.includes("TOP-SECRET-VALUE"));
      assert.equal(byId(dir).node.declared, null);
    }));

  it("strips control characters and caps the length of a declared version", () =>
    inDir({ ".nvmrc": `22${String.fromCharCode(27)}[2J${"9".repeat(200)}` }, (dir) => {
      const declared = byId(dir).node.declared ?? "";
      assert.ok(!declared.includes(String.fromCharCode(27)));
      assert.ok(declared.length <= 40);
    }));
});

const nodeReleases = [
  release("v26.12.1", "This is a security release. (CVE-2026-111497) brotli", {
    version: "26.12.1",
  }),
  release("v24.22.1", "This is a security release.", { version: "24.22.1" }),
  release("v22.23.4", "This is a security release.\n* (CVE-2026-111497) brotli: cherry-pick", {
    version: "22.23.4",
  }),
  release("v22.23.3", "Bug fixes", { version: "22.23.3" }),
  release("v22.23.2", "Bug fixes", { version: "22.23.2" }),
];

describe("decideRuntime", () => {
  it("flags a security release newer than the installed patch, with the lines that say so", () => {
    const got = decideRuntime(spec("node"), "22.23.3", nodeReleases, []);
    assert.equal(got.verdict, "security release available");
    assert.equal(got.latest, "22.23.4");
    assert.ok(got.evidence.some((l) => l.includes("CVE-2026-111497")));
  });

  it("is current on the newest patch of the installed line", () => {
    assert.equal(decideRuntime(spec("node"), "22.23.4", nodeReleases, []).verdict, "current");
  });

  it("says patch available when the newer releases carry no security wording", () => {
    const plain = nodeReleases.filter((r) => r.tag !== "v22.23.4");
    assert.equal(decideRuntime(spec("node"), "22.23.2", plain, []).verdict, "patch available");
  });

  it("ignores security releases of other lines", () => {
    const got = decideRuntime(spec("node"), "22.23.4", nodeReleases, []);
    assert.equal(got.verdict, "current");
    assert.deepEqual(got.evidence, []);
  });

  it("reads php tags with the php- prefix and keeps to the installed minor line", () => {
    const php = [
      release(
        "php-8.5.12",
        "This is a security release fixing two critical vulnerabilities (CVE-2026-109618)",
      ),
      release("php-8.4.27", "This is a security release (CVE-2026-1)"),
      release("php-8.5.6", "PHP 8.5.6"),
    ];
    const got = decideRuntime(spec("php"), "8.5.6", php, []);
    assert.equal(got.verdict, "security release available");
    assert.equal(got.latest, "8.5.12");
    assert.equal(decideRuntime(spec("php"), "8.5.12", php, []).verdict, "current");
  });
});

describe("decideRuntime tags, missing lines and clean evidence", () => {
  it("uses tags for python and says tags carry no notes", () => {
    const tags = ["v3.15.1", "v3.14.9", "v3.14.2", "v3.14.0rc1", "v22.23.3", "v3.14.10a1"];
    const got = decideRuntime(spec("python"), "3.14.2", [], tags);
    assert.equal(got.verdict, "patch available");
    assert.equal(got.latest, "3.14.9");
    assert.match(got.detail ?? "", /no release notes/);
  });

  it("is unknown, with the reason, when the installed line is not in the fetched window", () => {
    const got = decideRuntime(spec("python"), "3.9.6", [], ["v3.15.1", "v3.14.9"]);
    assert.equal(got.verdict, "unknown");
    assert.match(got.detail ?? "", /3\.9/);
    assert.match(got.detail ?? "", /end of life|window/);
  });

  it("is unknown when nothing is installed", () => {
    const got = decideRuntime(spec("node"), null, nodeReleases, []);
    assert.equal(got.verdict, "unknown");
    assert.match(got.detail ?? "", /not found/);
  });

  it("ignores prereleases and drafts, and treats an installed version ahead of latest as current", () => {
    const rel = [
      release("v22.99.0", "security release", { version: "22.99.0", prerelease: true }),
      release("v22.1.0", "x", { version: "22.1.0" }),
    ];
    assert.equal(decideRuntime(spec("node"), "22.5.0", rel, []).verdict, "current");
  });

  it("caps and cleans the evidence lines", () => {
    const body = Array.from(
      { length: 12 },
      (_, i) => `CVE-2026-${i} ${"x".repeat(400)}\u001b[2J`,
    ).join("\n");
    const got = decideRuntime(
      spec("node"),
      "22.0.0",
      [release("v22.0.1", body, { version: "22.0.1" })],
      [],
    );
    assert.ok(got.evidence.length <= 3);
    assert.ok(got.evidence.every((l) => l.length <= 200 && !l.includes("\u001b")));
  });
});

describe("resolveBinary (no planted interpreter from the repository)", () => {
  function fakeExe(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\necho planted\n", { mode: 0o755 });
    return file;
  }

  it("returns the first executable on an absolute PATH entry outside the project", () => {
    const base = mkdtempSync(join(tmpdir(), "kit-resolve-"));
    try {
      const project = join(base, "project");
      const good = fakeExe(join(base, "bin"), "node");
      mkdirSync(project);
      assert.equal(resolveBinary("node", join(base, "bin"), project), good);
    } finally {
      rmTemp(base);
    }
  });

  it("skips relative entries, empty entries and entries inside the project", () => {
    const base = mkdtempSync(join(tmpdir(), "kit-resolve-"));
    try {
      const project = join(base, "project");
      fakeExe(project, "node");
      fakeExe(join(project, "node_modules", ".bin"), "node");
      const path = [".", "", "bin", project, join(project, "node_modules", ".bin")].join(delimiter);
      assert.equal(resolveBinary("node", path, project), null);
    } finally {
      rmTemp(base);
    }
  });

  it("uses a later safe entry when an earlier one is inside the project", () => {
    const base = mkdtempSync(join(tmpdir(), "kit-resolve-"));
    try {
      const project = join(base, "project");
      fakeExe(project, "php");
      const good = fakeExe(join(base, "safe"), "php");
      assert.equal(
        resolveBinary("php", [project, join(base, "safe")].join(delimiter), project),
        good,
      );
    } finally {
      rmTemp(base);
    }
  });

  it("returns null for a name with a path separator, a missing binary or a file that is not executable", () => {
    const base = mkdtempSync(join(tmpdir(), "kit-resolve-"));
    try {
      writeFileSync(join(base, "node"), "x", { mode: 0o644 });
      assert.equal(resolveBinary("../node", base, join(base, "p")), null);
      assert.equal(resolveBinary("nothing", base, join(base, "p")), null);
      assert.equal(resolveBinary("node", base, join(base, "p")), null);
    } finally {
      rmTemp(base);
    }
  });
});

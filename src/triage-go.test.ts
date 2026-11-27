import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultGoDeps,
  goEscape,
  goRelease,
  parseGoTarget,
  triageGo,
  type GoTriageDeps,
} from "./triage-go.js";
import {
  daysAgo,
  startStubRegistry,
  UNREACHABLE,
  type StubRegistry,
} from "./triage-registry.test-support.js";

describe("parseGoTarget", () => {
  it("reads a package path with or without a version query", () => {
    assert.deepEqual(parseGoTarget("golang.org/x/tools/gopls"), {
      path: "golang.org/x/tools/gopls",
      query: "latest",
    });
    assert.deepEqual(parseGoTarget("github.com/BurntSushi/toml/cmd/tomlv@v1.4.0"), {
      path: "github.com/BurntSushi/toml/cmd/tomlv",
      query: "v1.4.0",
    });
    assert.deepEqual(parseGoTarget("rsc.io/quote@master"), {
      path: "rsc.io/quote",
      query: "master",
    });
  });

  it("refuses what is not a module path and a query", () => {
    for (const bad of [
      "",
      "tools",
      "cmd/go",
      "./cmd/x",
      "example.com/../x",
      "example.com/x@",
      "example.com/x@v1@v2",
      "example.com/x@v1;rm",
      "-flag.example/x",
      "example.com/a b",
    ])
      assert.equal(parseGoTarget(bad), null, bad);
  });
});

describe("goEscape", () => {
  it("writes an upper-case letter as ! and its lower-case form, as the proxy protocol does", () => {
    assert.equal(goEscape("github.com/BurntSushi/toml"), "github.com/!burnt!sushi/toml");
    assert.equal(goEscape("v1.0.0-RC1"), "v1.0.0-!r!c1");
    assert.equal(goEscape("golang.org/x/tools"), "golang.org/x/tools");
  });
});

describe("goRelease", () => {
  it("reads Version and Time, and is null without both", () => {
    const time = daysAgo(3);
    assert.deepEqual(goRelease("m", { Version: "v1.0.0", Time: time }), {
      module: "m",
      version: "v1.0.0",
      time,
    });
    for (const doc of [null, {}, { Version: "v1.0.0" }, { Version: "v1.0.0", Time: "soon" }])
      assert.equal(goRelease("m", doc), null);
  });
});

let stub: StubRegistry;
before(async () => {
  stub = await startStubRegistry({
    // A young release: `@latest` is one day old.
    "/example.com/fast-anything/@latest": { Version: "v0.1.0", Time: daysAgo(1) },
    "/example.com/fast-anything/@v/list": "v0.1.0\n",
    // The module is a prefix of the package path, and its path has upper-case letters.
    "/github.com/!burnt!sushi/toml/@latest": { Version: "v1.5.0", Time: daysAgo(300) },
    "/github.com/!burnt!sushi/toml/@v/v1.4.0.info": { Version: "v1.4.0", Time: daysAgo(700) },
    "/github.com/!burnt!sushi/toml/@v/list": "v1.4.0\nv1.5.0\nv1.3.2\n",
    // A branch resolves to a pseudo-version, and the proxy has no version list for it.
    "/example.com/untagged/@v/main.info": {
      Version: "v0.0.0-20260102150405-abcdef123456",
      Time: daysAgo(200),
    },
  });
});
after(() => stub.close());

function deps(env: NodeJS.ProcessEnv = {}, airGap = false): GoTriageDeps {
  return {
    ...defaultGoDeps,
    env: { KIT_GOPROXY: stub.url, KIT_OSV_API: stub.url, ...env },
    airGap: async () => ({ enabled: airGap, mirrors: {} }),
  };
}

describe("triageGo against a stub module proxy", () => {
  it("holds a one-day-old release on the cooling period", async () => {
    const r = await triageGo("/nonexistent", "example.com/fast-anything@latest", deps());
    assert.equal(r.passed, false);
    assert.match(r.output, /triaged v0\.1\.0 of module example\.com\/fast-anything/);
    assert.match(r.output, /x CRITICAL: cooling: v0\.1\.0 was published 1 days ago, limit 14/);
    assert.match(r.output, /Critical issues: 1\nWarnings: \d+\nTRIAGE HELD: cooling period$/);
  });

  it("finds the module that holds the package, passes an old release and says what rests on what", async () => {
    const r = await triageGo("/nonexistent", "github.com/BurntSushi/toml/cmd/tomlv", deps());
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /triaged v1\.5\.0 of module github\.com\/BurntSushi\/toml/);
    assert.match(r.output, /3 tagged version\(s\) on the proxy/);
    assert.match(
      r.output,
      /~ NOT CHECKED: publish time -- the proxy gives the date of the tagged commit/,
    );
    assert.match(r.output, /~ NOT CHECKED: module source/);
    assert.match(r.output, /TRIAGE PASSED$/);
    assert.ok(stub.asked.includes("GET /github.com/!burnt!sushi/toml/cmd/tomlv/@latest"));
  });

  it("reads an exact version from its .info document", async () => {
    const r = await triageGo("/nonexistent", "github.com/BurntSushi/toml@v1.4.0", deps());
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /triaged v1\.4\.0/);
  });

  it("warns on a pseudo-version and says the release history could not be read", async () => {
    const r = await triageGo("/nonexistent", "example.com/untagged@main", deps());
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /! WARNING: v0\.0\.0-20260102150405-abcdef123456 is a pseudo-version/);
    assert.match(
      r.output,
      /~ NOT CHECKED: release history -- the proxy's version list could not be read/,
    );
  });
});

describe("triageGo: what fails, and what is said when a probe cannot run", () => {
  it("fails on an OSV malicious record, asked without the leading v", async () => {
    stub.vulns = [{ id: "MAL-2026-0003" }];
    try {
      const r = await triageGo("/nonexistent", "github.com/BurntSushi/toml@v1.4.0", deps());
      assert.equal(r.passed, false);
      assert.match(r.output, /x CRITICAL: malicious package: MAL-2026-0003 \(OSV\)/);
    } finally {
      stub.vulns = [];
    }
  });

  it("says NOT CHECKED when OSV cannot be reached, and still passes an old release", async () => {
    const r = await triageGo(
      "/nonexistent",
      "github.com/BurntSushi/toml@v1.4.0",
      deps({ KIT_OSV_API: UNREACHABLE }),
    );
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /~ NOT CHECKED: advisories -- OSV could not be queried/);
  });

  it("fails closed when the proxy cannot be reached or knows no such module", async () => {
    const down = await triageGo(
      "/nonexistent",
      "github.com/BurntSushi/toml@v1.4.0",
      deps({ KIT_GOPROXY: UNREACHABLE }),
    );
    assert.equal(down.passed, false);
    assert.match(
      down.output,
      /no module for 'github\.com\/BurntSushi\/toml@v1\.4\.0' on .*proxy could not be read/,
    );
    assert.match(down.output, /TRIAGE FAILED$/);
    const unknown = await triageGo("/nonexistent", "example.com/nothing/here@latest", deps());
    assert.equal(unknown.passed, false);
  });

  it("under air-gap asks nothing without a mirror, and uses the mirror when one is named", async () => {
    const before = stub.asked.length;
    const off = await triageGo(
      "/nonexistent",
      "github.com/BurntSushi/toml@v1.4.0",
      deps({ KIT_GOPROXY: "", KIT_OSV_API: "" }, true),
    );
    assert.equal(off.passed, false);
    assert.match(off.output, /air-gap is on and no KIT_GOPROXY mirror is named/);
    assert.equal(stub.asked.length, before);
    const mirrored = await triageGo(
      "/nonexistent",
      "github.com/BurntSushi/toml@v1.4.0",
      deps({}, true),
    );
    assert.equal(mirrored.passed, true, mirrored.output);
  });

  it("refuses a target that is not a module path before asking anything", async () => {
    const before = stub.asked.length;
    const r = await triageGo("/nonexistent", "./cmd/tool", deps());
    assert.equal(r.passed, false);
    assert.match(r.output, /is not a Go package path or path@version/);
    assert.equal(stub.asked.length, before);
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCoolingDeps, type CoolingDeps } from "./triage-cooling.js";
import { crateOwners, crateView, parseCrateTarget, triageCargo } from "./triage-cargo.js";
import {
  crateDoc,
  startStubRegistry,
  UNREACHABLE,
  type StubRegistry,
} from "./triage-registry.test-support.js";

const OWNERS = { users: [{ login: "alice" }, { login: "bob" }] };

describe("parseCrateTarget", () => {
  it("reads name and name@version, and refuses anything else", () => {
    assert.deepEqual(parseCrateTarget("ripgrep"), { name: "ripgrep" });
    assert.deepEqual(parseCrateTarget("serde_json@1.0.120"), {
      name: "serde_json",
      version: "1.0.120",
    });
    for (const bad of ["", "-rf", "a@b@c", "x@", "x@^1", "x@1.2", "../x", "a/b", "x@;rm"])
      assert.equal(parseCrateTarget(bad), null, bad);
  });
});

describe("crateView", () => {
  it("keeps yanked versions out of the installable list and takes the registry's stable version", () => {
    const view = crateView(
      crateDoc(
        [
          ["2.0.0-rc.1", 1],
          ["1.1.0", 3, true],
          ["1.0.0", 90],
        ],
        7,
        "1.0.0",
      ),
    );
    assert.deepEqual(view?.versions, ["2.0.0-rc.1", "1.0.0"]);
    assert.ok(view?.yanked.has("1.1.0"));
    assert.equal(view?.stable, "1.0.0");
    assert.equal(view?.downloads, 7);
  });

  it("falls back to the newest stable version when the registry names a yanked one", () => {
    const doc = crateDoc(
      [
        ["1.2.0", 2, true],
        ["1.1.0", 40],
        ["1.0.0", 90],
      ],
      7,
      "1.2.0",
    );
    assert.equal(crateView(doc)?.stable, "1.1.0");
  });

  it("is null for anything that is not a crate document", () => {
    for (const doc of [null, [], { errors: [{ detail: "Not Found" }] }, { versions: [] }])
      assert.equal(crateView(doc), null);
  });
});

describe("crateOwners", () => {
  it("lists logins, and is null when the answer is not an owners list", () => {
    assert.deepEqual(crateOwners(OWNERS), ["alice", "bob"]);
    assert.equal(crateOwners(null), null);
    assert.equal(crateOwners({ errors: [] }), null);
  });
});

let stub: StubRegistry;
before(async () => {
  stub = await startStubRegistry({
    "/api/v1/crates/fast-anything": crateDoc([["0.1.0", 1]], 12),
    "/api/v1/crates/fast-anything/owners": OWNERS,
    "/api/v1/crates/ripgrep": crateDoc(
      [
        ["15.0.0", 3],
        ["14.1.1", 400],
        ["14.1.0", 500, true],
      ],
      9_000_000,
    ),
    "/api/v1/crates/ripgrep/owners": OWNERS,
    "/api/v1/crates/noowners": crateDoc([["1.0.0", 300]]),
  });
});
after(() => stub.close());

function deps(env: NodeJS.ProcessEnv = {}, airGap = false): CoolingDeps {
  return {
    ...defaultCoolingDeps,
    env: { KIT_CRATES_REGISTRY: stub.url, KIT_OSV_API: stub.url, ...env },
    airGap: async () => ({ enabled: airGap, mirrors: {} }),
  };
}

describe("triageCargo against a stub crates.io", () => {
  it("holds a one-day-old crate on the cooling period, as npm does", async () => {
    const r = await triageCargo("/nonexistent", "fast-anything", deps());
    assert.equal(r.passed, false);
    assert.match(r.output, /triaged 0\.1\.0, 1 version\(s\), 12 downloads in total/);
    assert.match(r.output, /x CRITICAL: cooling: 0\.1\.0 was published 1 days ago, limit 14/);
    assert.match(r.output, /! WARNING: new crate: first published 1 day\(s\) ago/);
    assert.match(r.output, /TRIAGE HELD: cooling period$/);
  });

  it("only warns when the project turns enforcement off", async () => {
    const r = await triageCargo(
      "/nonexistent",
      "fast-anything",
      deps({ KIT_COOLING_ENFORCE: "0" }),
    );
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /! WARNING: cooling: 0\.1\.0 was published 1 days ago/);
  });

  it("names the newest version that is old enough when the latest is too young", async () => {
    const r = await triageCargo("/nonexistent", "ripgrep", deps());
    assert.equal(r.passed, false);
    assert.match(r.output, /newest version public for 14 days or more: ripgrep@14\.1\.1/);
  });

  it("passes an old release, lists its owners and says what it did not read", async () => {
    const r = await triageCargo("/nonexistent", "ripgrep@14.1.1", deps());
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /2 owner\(s\): alice, bob/);
    assert.match(r.output, /NOT CHECKED: build-time code -- a crate's build\.rs/);
    assert.match(r.output, /TRIAGE PASSED$/);
  });

  it("sends a generic User-Agent, which crates.io requires", () => {
    assert.ok(stub.agents.length > 0);
    assert.ok(
      stub.agents.every((agent) => agent === "kit-triage/1.0"),
      stub.agents.join(),
    );
  });
});

describe("triageCargo: what fails, and what is said when a probe cannot run", () => {
  it("fails a yanked version and one that was never published", async () => {
    const yanked = await triageCargo("/nonexistent", "ripgrep@14.1.0", deps());
    assert.equal(yanked.passed, false);
    assert.match(yanked.output, /ripgrep@14\.1\.0 was yanked from the registry/);
    const missing = await triageCargo("/nonexistent", "ripgrep@9.9.9", deps());
    assert.match(missing.output, /ripgrep@9\.9\.9 is not published/);
  });

  it("fails on an OSV malicious record even when the release is old", async () => {
    stub.vulns = [{ id: "MAL-2026-0001" }, { id: "RUSTSEC-2026-0002" }];
    try {
      const r = await triageCargo("/nonexistent", "ripgrep@14.1.1", deps());
      assert.equal(r.passed, false);
      assert.match(r.output, /x CRITICAL: malicious package: MAL-2026-0001 \(OSV\)/);
      assert.match(r.output, /! WARNING: known vulnerabilities in 14\.1\.1: RUSTSEC-2026-0002/);
      assert.match(r.output, /TRIAGE FAILED$/);
    } finally {
      stub.vulns = [];
    }
  });

  it("says NOT CHECKED for the probes that could not run: owners and advisories", async () => {
    const r = await triageCargo("/nonexistent", "noowners", deps({ KIT_OSV_API: UNREACHABLE }));
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /~ NOT CHECKED: owners -- the crates\.io owners list could not be read/);
    assert.match(r.output, /~ NOT CHECKED: advisories -- OSV could not be queried/);
  });

  it("fails closed when the registry cannot be reached or does not know the crate", async () => {
    const down = await triageCargo(
      "/nonexistent",
      "ripgrep",
      deps({ KIT_CRATES_REGISTRY: UNREACHABLE }),
    );
    assert.equal(down.passed, false);
    assert.match(
      down.output,
      /crate 'ripgrep' not found on http:\/\/127\.0\.0\.1:9 \(or the registry/,
    );
    assert.match(down.output, /TRIAGE FAILED$/);
    const unknown = await triageCargo("/nonexistent", "no-such-crate", deps());
    assert.equal(unknown.passed, false);
  });

  it("under air-gap asks nothing without a mirror, and uses the mirror when one is named", async () => {
    const before = stub.asked.length;
    const off = await triageCargo(
      "/nonexistent",
      "ripgrep",
      deps({ KIT_CRATES_REGISTRY: "", KIT_OSV_API: "" }, true),
    );
    assert.equal(off.passed, false);
    assert.match(off.output, /air-gap is on and no KIT_CRATES_REGISTRY mirror is named/);
    assert.equal(stub.asked.length, before);
    const mirrored = await triageCargo("/nonexistent", "ripgrep@14.1.1", deps({}, true));
    assert.equal(mirrored.passed, true, mirrored.output);
    assert.ok(stub.asked.length > before);
  });

  it("refuses a target that is not a crate name before asking anything", async () => {
    const before = stub.asked.length;
    const r = await triageCargo("/nonexistent", "../../etc/passwd", deps());
    assert.equal(r.passed, false);
    assert.match(r.output, /is not a crate name or name@version/);
    assert.equal(stub.asked.length, before);
  });
});

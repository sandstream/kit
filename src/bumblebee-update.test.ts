import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseReleaseTag,
  pickLatestStableRelease,
  bumblebeeUpdateFrom,
  formatBumblebeeNotice,
  checkForBumblebeeUpdate,
} from "./bumblebee-update.js";
import { advisoryFindings } from "./findings-track.js";
import type { SecurityCheckResult } from "./check-security.js";

describe("parseReleaseTag", () => {
  it("strips a leading v and accepts a plain version", () => {
    assert.equal(parseReleaseTag("v0.2.0"), "0.2.0");
    assert.equal(parseReleaseTag("0.2.0"), "0.2.0");
    assert.equal(parseReleaseTag("  V1.10.3 "), "1.10.3");
  });

  it("returns null for anything we cannot compare — no notice beats a wrong one", () => {
    for (const t of ["nightly", "release-20260721.0", "", "v", null, undefined, 3, {}, []])
      assert.equal(parseReleaseTag(t), null, `must reject ${JSON.stringify(t)}`);
  });
});

describe("pickLatestStableRelease", () => {
  it("takes the highest version, not the first array entry", () => {
    const payload = [{ tag_name: "v0.1.1" }, { tag_name: "v0.3.0" }, { tag_name: "v0.2.5" }];
    assert.equal(pickLatestStableRelease(payload), "0.3.0");
  });

  it("skips drafts and prereleases", () => {
    const payload = [
      { tag_name: "v0.9.0", draft: true },
      { tag_name: "v0.8.0", prerelease: true },
      { tag_name: "v0.2.0" },
    ];
    assert.equal(pickLatestStableRelease(payload), "0.2.0");
  });

  it("accepts a single release object (the /releases/latest shape)", () => {
    assert.equal(pickLatestStableRelease({ tag_name: "v0.4.0" }), "0.4.0");
  });

  it("returns null for junk, an empty list, or all-unparseable tags", () => {
    assert.equal(pickLatestStableRelease([]), null);
    assert.equal(pickLatestStableRelease(null), null);
    assert.equal(pickLatestStableRelease("nope"), null);
    assert.equal(pickLatestStableRelease([{ tag_name: "nightly" }]), null);
    assert.equal(pickLatestStableRelease({ message: "API rate limit exceeded" }), null);
  });
});

describe("bumblebeeUpdateFrom", () => {
  it("reports only a genuinely newer upstream release", () => {
    assert.deepEqual(bumblebeeUpdateFrom("0.1.1", "0.2.0"), { pinned: "0.1.1", latest: "0.2.0" });
    assert.equal(bumblebeeUpdateFrom("0.2.0", "0.2.0"), null);
    assert.equal(bumblebeeUpdateFrom("0.3.0", "0.2.0"), null, "never suggests a downgrade");
  });

  it("fails closed on malformed versions (no notice)", () => {
    assert.equal(bumblebeeUpdateFrom("0.1.1", "garbage"), null);
    assert.equal(bumblebeeUpdateFrom("", "0.2.0"), null);
  });
});

describe("checkForBumblebeeUpdate — suppression posture", () => {
  /** Run `fn` with env vars applied, restoring the previous values after. */
  async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("makes no outbound call under air-gap, CI, or the explicit opt-out", async () => {
    // The point is the POSTURE, not the network: patch fetch to fail loudly if called.
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("fetch must not be called under a suppressed posture");
    }) as typeof fetch;
    try {
      const postures: Record<string, string>[] = [
        { KIT_AIRGAP: "1" },
        { CI: "true" },
        { GITHUB_ACTIONS: "true" },
        { GITLAB_CI: "true" },
        { KIT_NO_UPDATE_CHECK: "1" },
      ];
      for (const vars of postures) {
        await withEnv(vars, async () => {
          assert.equal(await checkForBumblebeeUpdate("0.1.1"), null);
        });
        assert.equal(called, false, `fetch called despite ${JSON.stringify(vars)}`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never throws when the network fails", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    try {
      await withEnv(
        { KIT_AIRGAP: "", CI: "", GITHUB_ACTIONS: "", GITLAB_CI: "", KIT_NO_UPDATE_CHECK: "" },
        async () => {
          // Either null (fetch failed) or a cached answer — the contract is "no throw".
          await checkForBumblebeeUpdate("0.1.1");
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("formatBumblebeeNotice", () => {
  it("names both versions and says the two pins move together", () => {
    const s = formatBumblebeeNotice({ pinned: "0.1.1", latest: "0.2.0" });
    assert.match(s, /0\.1\.1/);
    assert.match(s, /0\.2\.0/);
    assert.match(s, /BUMBLEBEE_VERSION/);
    assert.match(s, /TARBALL_CHECKSUMS/);
  });
});

describe("advisoryFindings — the PAL bridge", () => {
  const base: SecurityCheckResult = {
    category: "supply-chain",
    name: "bumblebee (supply-chain)",
    status: "pass",
    detail: "no known exposures",
  };

  it("carries an advisory off a PASS result — invisible to the fail/warn filter", () => {
    const out = advisoryFindings([{ ...base, advisory: { key: "k1", title: "t1", detail: "d1" } }]);
    assert.deepEqual(out, [{ dedupKey: "k1", title: "t1", detail: "d1" }]);
  });

  it("ignores results with no advisory", () => {
    assert.deepEqual(advisoryFindings([base, { ...base, status: "fail" }]), []);
  });

  it("keys on the advisory key, so a climbing day count does not open a new row daily", () => {
    const day1 = advisoryFindings([
      { ...base, advisory: { key: "bumblebee-catalogs-stale", title: "65 days old", detail: "d" } },
    ]);
    const day2 = advisoryFindings([
      { ...base, advisory: { key: "bumblebee-catalogs-stale", title: "66 days old", detail: "d" } },
    ]);
    assert.equal(day1[0].dedupKey, day2[0].dedupKey);
    assert.notEqual(day1[0].title, day2[0].title, "the title still tells the truth about age");
  });
});

/**
 * The triage score is a flat penalty count (`100 - 45*crit - 12*warn`), so it falls out of
 * how many probes an ecosystem HAS, not out of how safe the package is.
 *
 * Measured against 6.6.3 (#489):
 *
 *   kit triage npm deepsec           -> 88/100   ! single maintainer
 *   kit triage npm @deepseek-ai/dsh  -> 88/100   ! package is very new (4 days)
 *   kit triage pip opensandbox-server -> 100/100 (no warnings)
 *
 * Both 88s existed only because the npm path looked for something the pip path never did.
 * A reader comparing the two numbers in the same CLI concludes the Python package is the
 * safer one — a verdict that reads stronger than its evidence, which is kit's own
 * `didNotRun` rule inverted.
 *
 * These tests run the real `triage.py` against a LOCAL registry fixture (both hosts are
 * env-overridable for air-gapped mirrors, which makes them injectable here), so the
 * assertions are on the script's actual stdout — the text kit prints verbatim to the
 * operator — not on a re-implementation of its logic.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const TRIAGE_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "triage.py",
);

const iso = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, ".000000Z");

/** PyPI `/pypi/<name>/json`, PEP 621 shape: `author` null, attribution in `author_email`. */
function pypiPackage(opts: {
  version: string;
  firstReleaseDaysAgo: number;
  lastReleaseDaysAgo: number;
  authorEmail?: string | null;
  author?: string | null;
  maintainerEmail?: string | null;
  license?: string;
}): unknown {
  const older = `0.0.1`;
  return {
    info: {
      version: opts.version,
      author: opts.author ?? null,
      author_email: opts.authorEmail ?? null,
      maintainer: null,
      maintainer_email: opts.maintainerEmail ?? null,
      license: opts.license ?? "Apache-2.0",
      classifiers: ["License :: OSI Approved :: Apache Software License"],
    },
    releases: {
      [older]: [
        {
          yanked: false,
          upload_time_iso_8601: iso(opts.firstReleaseDaysAgo),
        },
      ],
      [opts.version]: [
        {
          yanked: false,
          upload_time_iso_8601: iso(opts.lastReleaseDaysAgo),
        },
      ],
    },
  };
}

/** npm packument, trimmed to the fields the npm path reads. */
function npmPackument(opts: {
  version: string;
  createdDaysAgo: number;
  publishedDaysAgo: number;
  maintainers: number;
  license?: string | null;
}): unknown {
  return {
    "dist-tags": { latest: opts.version },
    versions: {
      [opts.version]: {
        name: "fixture",
        version: opts.version,
        ...(opts.license === null ? {} : { license: opts.license ?? "Apache-2.0" }),
      },
    },
    time: {
      created: iso(opts.createdDaysAgo),
      [opts.version]: iso(opts.publishedDaysAgo),
    },
    maintainers: Array.from({ length: opts.maintainers }, (_, i) => ({
      name: `m${i}`,
      email: `m${i}@example.test`,
    })),
  };
}

describe("triage ecosystem parity (real triage.py against a local registry)", () => {
  let server: Server;
  let base = "";
  const routes = new Map<string, unknown>();

  before(async () => {
    server = createServer((req, res) => {
      const body = routes.get(req.url ?? "");
      if (body === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no fixture port");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /**
   * Skips LOUDLY when python3 is absent: the script under test IS python, so a silent
   * skip here would report a passing suite for a probe that never ran — the same defect
   * class this file exists to close.
   */
  const runTriage = async (
    type: "npm" | "pip",
    target: string,
    t: { skip: (m: string) => void },
  ): Promise<string | null> => {
    try {
      const { stdout } = await exec("python3", [TRIAGE_PY, type, target], {
        env: {
          ...process.env,
          KIT_PYPI_INDEX: base,
          KIT_NPM_REGISTRY: base,
        },
        timeout: 30_000,
      });
      return stdout;
    } catch (err) {
      const e = err as { code?: string | number; stdout?: string };
      if (e.code === "ENOENT") {
        t.skip("python3 not installed — triage.py's own behaviour is NOT verified in this run");
        return null;
      }
      // The script exits 0 on a completed evaluation, so a non-zero exit is a real failure.
      throw err;
    }
  };

  it("a single declared maintainer warns, and says the number is not npm's", async (t) => {
    // Was: this fixture scored 100/100 with a PARTIAL-coverage note, because the maintainer
    // probe was declared unavailable on the claim that PyPI publishes no maintainer list.
    // Measured wrong — `author_email` names one here, so the probe RUNS, warns, and the score
    // drops for the same reason npm's did. What must not come back is presenting it as parity.
    routes.set(
      "/pypi/opensandbox-server/json",
      pypiPackage({
        version: "1.4.0",
        firstReleaseDaysAgo: 400,
        lastReleaseDaysAgo: 20,
        authorEmail: "OpenSandbox Team <team@example.test>",
      }),
    );
    const out = await runTriage("pip", "opensandbox-server", t);
    if (out === null) return;

    assert.match(out, /Health score: 88\/100/);
    assert.match(out, /single declared maintainer in author_email/);
    assert.match(out, /not comparable to npm's maintainer count/);
    assert.match(out, /Probes declared unavailable: 0/);
    assert.ok(
      out.split("\n").includes("TRIAGE PASSED"),
      "a warning is not a critical — the package still passes",
    );
  });

  it("PEP 621 attribution comes from author_email, not 'unknown'", async (t) => {
    routes.set(
      "/pypi/pep621-pkg/json",
      pypiPackage({
        version: "2.0.0",
        firstReleaseDaysAgo: 900,
        lastReleaseDaysAgo: 30,
        author: null,
        authorEmail: "OpenSandbox Team <team@alibaba-inc.example>",
      }),
    );
    const out = await runTriage("pip", "pep621-pkg", t);
    if (out === null) return;

    assert.match(out, /author: OpenSandbox Team <team@alibaba-inc\.example>/);
    assert.doesNotMatch(out, /author: unknown/);
  });

  it("the pip path now warns on a very new package, like npm always did", async (t) => {
    routes.set(
      "/pypi/fresh-pkg/json",
      pypiPackage({
        version: "0.1.0",
        firstReleaseDaysAgo: 4,
        lastReleaseDaysAgo: 1,
        authorEmail: "a@example.test",
      }),
    );
    const out = await runTriage("pip", "fresh-pkg", t);
    if (out === null) return;

    assert.match(out, /first published 4 days ago/);
    assert.match(out, /package is very new \(4 days\) -- limited track record/);
    // Two warnings now: newness AND a single declared maintainer (author_email names one).
    // 100 - 12 - 12 = 76. The old 88 encoded a maintainer probe that did not run.
    assert.match(out, /Health score: 76\/100/);
    assert.match(out, /single declared maintainer/);
  });

  it("an npm package with the same shape scores the same as pip on the shared probes", async (t) => {
    routes.set(
      "/fresh-npm",
      npmPackument({
        version: "0.1.0",
        createdDaysAgo: 4,
        publishedDaysAgo: 1,
        // Two maintainers: isolates the newness probe, which is the one pip was missing.
        maintainers: 2,
      }),
    );
    const npmOut = await runTriage("npm", "fresh-npm", t);
    if (npmOut === null) return;

    assert.match(npmOut, /package is very new \(4 days\) -- limited track record/);
    assert.match(npmOut, /Health score: 88\/100/);
    // npm answers maintainer count, so it declares no gap — that asymmetry is the point:
    // the reader can now see WHY two 88s are not the same 88.
    assert.match(npmOut, /Probes declared unavailable: 0/);
    assert.doesNotMatch(npmOut, /Coverage: PARTIAL/);
  });

  it("npm no longer prints a clean score for a package with no declared license", async (t) => {
    routes.set(
      "/no-license",
      npmPackument({
        version: "3.2.1",
        createdDaysAgo: 800,
        publishedDaysAgo: 40,
        maintainers: 3,
        license: null,
      }),
    );
    const out = await runTriage("npm", "no-license", t);
    if (out === null) return;

    assert.match(out, /no declared license -- review terms before use/);
    assert.match(out, /Health score: 88\/100/);
  });

  it("a single-maintainer npm package still warns (bus factor), and pip says it cannot", async (t) => {
    routes.set(
      "/solo-pkg",
      npmPackument({
        version: "1.0.0",
        createdDaysAgo: 500,
        publishedDaysAgo: 10,
        maintainers: 1,
      }),
    );
    routes.set(
      "/pypi/solo-pkg/json",
      pypiPackage({ version: "1.0.0", firstReleaseDaysAgo: 500, lastReleaseDaysAgo: 10 }),
    );

    const npmOut = await runTriage("npm", "solo-pkg", t);
    if (npmOut === null) return;
    const pipOut = await runTriage("pip", "solo-pkg", t);
    if (pipOut === null) return;

    assert.match(npmOut, /single maintainer -- bus-factor \/ takeover risk/);
    assert.match(npmOut, /Health score: 88\/100/);

    // The pip score is still higher for the same package shape — that is inherent to a
    // flat penalty count. What must never happen again is that being invisible.
    assert.match(pipOut, /Health score: 100\/100/);
    assert.match(pipOut, /Coverage: PARTIAL/);
    assert.match(pipOut, /maintainer count/);
  });

  it("a missing package is still a fail-closed CRITICAL, coverage lines notwithstanding", async (t) => {
    const out = await runTriage("pip", "no-such-package-xyz", t);
    if (out === null) return;

    assert.match(out, /CRITICAL: package 'no-such-package-xyz' not found on PyPI/);
    assert.ok(out.split("\n").includes("TRIAGE FAILED"));
    assert.doesNotMatch(out, /TRIAGE PASSED/);
  });
  /**
   * The maintainer count, corrected.
   *
   * The first pass declared this probe unavailable on the claim that "PyPI publishes no maintainer
   * list". Measured, that was wrong: `requests` carries
   * `maintainer_email = "Ian Stapleton Cordasco <…>, Nate Prewitt <…>"`, which is countable.
   * Two things still make it NOT npm's number, and both are asserted here: PEP 621 leaves
   * `maintainer` null so the value hides in `maintainer_email` (and sometimes only in
   * `author_email`), and PyPI's list is self-declared metadata inside the package while npm's is
   * the registry's own record of who may publish. So the count is reported for what it is, or the
   * probe is declared unavailable when the package names nobody — never presented as parity.
   */
  describe("pip maintainer count (self-declared, not publish rights)", () => {
    it("counts two comma-separated maintainers out of maintainer_email", async (t) => {
      routes.set(
        "/pypi/two-maintainers/json",
        pypiPackage({
          version: "2.32.0",
          firstReleaseDaysAgo: 4000,
          lastReleaseDaysAgo: 30,
          authorEmail: "Kenneth Reitz <me@example.test>",
          maintainerEmail: "Ian Cordasco <a@example.test>, Nate Prewitt <b@example.test>",
        }),
      );
      const out = await runTriage("pip", "two-maintainers", t);
      if (out === null) return;
      assert.match(out, /2 declared maintainer\(s\) in maintainer_email/);
      assert.doesNotMatch(out, /single declared maintainer/);
      assert.match(out, /Probes declared unavailable: 0/);
    });

    it("falls back to author_email, warns, and refuses to claim npm parity", async (t) => {
      routes.set(
        "/pypi/one-maintainer/json",
        pypiPackage({
          version: "0.2.2",
          firstReleaseDaysAgo: 200,
          lastReleaseDaysAgo: 20,
          authorEmail: "Solo Dev <solo@example.test>",
          maintainerEmail: null,
        }),
      );
      const out = await runTriage("pip", "one-maintainer", t);
      if (out === null) return;
      assert.match(out, /1 declared maintainer\(s\) in author_email/);
      assert.match(out, /single declared maintainer in author_email/);
      // The caveat is the point: this number is not npm's.
      assert.match(out, /not registry publish rights/);
      assert.match(out, /not comparable to npm's maintainer count/);
      assert.match(out, /Health score: 88\/100/);
    });

    it("counts by email brackets, so a comma inside a display name is not a second maintainer", async (t) => {
      routes.set(
        "/pypi/comma-name/json",
        pypiPackage({
          version: "1.0.0",
          firstReleaseDaysAgo: 900,
          lastReleaseDaysAgo: 40,
          maintainerEmail: "Cordasco, Ian <only@example.test>",
        }),
      );
      const out = await runTriage("pip", "comma-name", t);
      if (out === null) return;
      assert.match(out, /1 declared maintainer\(s\)/);
      assert.doesNotMatch(out, /2 declared maintainer/);
    });

    it("declares the probe unavailable — with an accurate reason — when nobody is named", async (t) => {
      routes.set(
        "/pypi/anonymous-pkg/json",
        pypiPackage({
          version: "1.0.0",
          firstReleaseDaysAgo: 900,
          lastReleaseDaysAgo: 40,
          author: null,
          authorEmail: null,
          maintainerEmail: null,
        }),
      );
      const out = await runTriage("pip", "anonymous-pkg", t);
      if (out === null) return;
      assert.match(out, /NOT CHECKED: maintainer count/);
      assert.match(out, /neither maintainer_email nor author_email names anyone/);
      // The old wording claimed PyPI has no such field at all. It does; this package has none.
      assert.doesNotMatch(out, /publishes no maintainer list/);
      assert.match(out, /Coverage: PARTIAL/);
    });
  });
});

import { it } from "node:test";
import assert from "node:assert/strict";
import { inspectNpmLock } from "./npm-lock.js";
import { bytes, fixture, input } from "./npm-lock.test-support.js";

it("refuses malformed JSON and malformed schema without throwing or claiming completeness", () => {
  const cases = [
    { manifest: new TextEncoder().encode("{") },
    { lockfile: new TextEncoder().encode("{") },
    { manifest: bytes(null) },
    { manifest: bytes([]) },
    { lockfile: bytes(null) },
    { lockfile: bytes([]) },
    { manifest: bytes({ dependencies: null, scripts: [] }) },
    { manifest: bytes({ dependencies: { alpha: 42 } }) },
    { lockfile: bytes({ lockfileVersion: 3, packages: [] }) },
    { lockfile: bytes({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": null } }) },
    {
      lockfile: bytes({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/a": { version: 1, hasInstallScript: "false" } },
      }),
    },
  ];
  for (const malformed of cases) {
    const result = inspectNpmLock({ ...input(), ...malformed });
    assert.equal(result.completeness.status, "incomplete", JSON.stringify(malformed));
    assert.ok(result.issues.some((i) => ["invalid-json", "invalid-schema"].includes(i.code)));
    assert.equal(result.verification, "not-performed");
  }
});

it("requires strict UTF-8 for both inputs and accepts one leading UTF-8 BOM", () => {
  const good = input();
  const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
  const result = inspectNpmLock({
    ...good,
    manifest: Uint8Array.from([...bom, ...good.manifest]),
    lockfile: Uint8Array.from([...bom, ...good.lockfile]),
  });
  assert.equal(result.completeness.status, "complete");
  for (const field of ["manifest", "lockfile"] as const) {
    const invalid = Uint8Array.from([
      ...new TextEncoder().encode('{"name":"'),
      0xff,
      ...new TextEncoder().encode('"}'),
    ]);
    const report = inspectNpmLock({ ...good, [field]: invalid });
    assert.equal(report.completeness.status, "incomplete");
    assert.ok(report.issues.some((i) => i.code === "invalid-utf8"));
  }
});

it("preserves v2 and shrinkwrap identity but refuses unsupported versions and legacy-only inventories", () => {
  const f = fixture();
  f.lock.lockfileVersion = 2;
  const v2 = { ...f.lock, dependencies: { decoy: { version: "9.0.0" } } };
  const report = inspectNpmLock({
    ...input(f),
    lockfile: bytes(v2),
    lockfileName: "npm-shrinkwrap.json",
  });
  assert.equal(report.lockfileVersion, 2);
  assert.equal(report.lockfileName, "npm-shrinkwrap.json");
  assert.equal(report.completeness.status, "complete");
  assert.deepEqual(
    report.artifacts.map((a) => a.name),
    ["alpha"],
  );
  for (const version of [undefined, 0, 1, 4, "3", null]) {
    const invalid = inspectNpmLock({
      ...input(),
      lockfile: bytes({ ...f.lock, lockfileVersion: version }),
    });
    assert.equal(invalid.lockfileVersion, null);
    assert.equal(invalid.completeness.status, "incomplete");
    assert.ok(invalid.issues.some((i) => i.code === "unsupported-lock-version"));
    assert.deepEqual(invalid.artifacts, []);
  }
  const legacy = inspectNpmLock({
    ...input(),
    lockfile: bytes({ lockfileVersion: 2, dependencies: v2.dependencies }),
  });
  assert.equal(legacy.completeness.status, "incomplete");
  assert.deepEqual(legacy.artifacts, []);
  const noRoot = inspectNpmLock({
    ...input(),
    lockfile: bytes({ lockfileVersion: 3, packages: {} }),
  });
  assert.ok(noRoot.issues.some((i) => i.code === "missing-root"));
});

it("bounds input size and nesting and refuses duplicate JSON keys before inventory", () => {
  const duplicate = '{"lockfileVersion":2,"lockfileVersion":3,"packages":{"":{}}}';
  const escapedDuplicate =
    '{"lockfileVersion":3,"packages":{"":{"name":"one","n\\u0061me":"two"}}}';
  for (const content of [duplicate, escapedDuplicate]) {
    const report = inspectNpmLock({ ...input(), lockfile: new TextEncoder().encode(content) });
    assert.ok(report.issues.some((i) => i.code === "duplicate-json-key"));
    assert.equal(report.completeness.status, "incomplete");
    assert.deepEqual(report.packages, []);
  }
  const tooDeep = '{"unused":' + "[".repeat(129) + "0" + "]".repeat(129) + "}";
  const oversized = new Uint8Array(16 * 1024 * 1024 + 1).fill(32);
  for (const value of [new TextEncoder().encode(tooDeep), oversized]) {
    const report = inspectNpmLock({ ...input(), lockfile: value });
    assert.ok(report.issues.some((i) => i.code === "input-limit"));
    assert.equal(report.completeness.status, "incomplete");
    assert.deepEqual(report.packages, []);
  }
});

it("refuses malformed inventory fields without silently converting them to absent values", () => {
  const cases = [
    { name: "", version: "1.0.0" },
    { version: "" },
    { version: null },
    { hasInstallScript: 0 },
    { scripts: { install: 9 } },
    { dependencies: { "../escape": "1" } },
    { dependencies: { alpha: "" } },
    { peerDependenciesMeta: [] },
    { workspaces: { packages: ["packages/*"] } },
  ];
  for (const fields of cases) {
    const f = fixture();
    Object.assign(f.lock.packages["node_modules/alpha"], fields);
    const report = inspectNpmLock(input(f));
    assert.equal(report.completeness.status, "incomplete", JSON.stringify(fields));
    assert.ok(
      report.issues.some(
        (i) => i.code === "invalid-schema" || i.code === "unsupported-package-metadata",
      ),
      JSON.stringify(fields),
    );
  }
});

it("validates top-level identity and requires fetched package identity without inventing root names", () => {
  const empty = inspectNpmLock({
    manifest: bytes({}),
    lockfile: bytes({ lockfileVersion: 3, packages: { "": {} } }),
    lockfileName: "package-lock.json",
  });
  assert.equal(empty.completeness.status, "complete");
  assert.equal(empty.packages[0].name, null);
  const top = inspectNpmLock({
    manifest: bytes({}),
    lockfile: bytes({ lockfileVersion: 3, name: [], packages: { "": {} } }),
    lockfileName: "package-lock.json",
  });
  assert.ok(top.issues.some((i) => i.code === "invalid-schema"));
  const f = fixture();
  delete f.lock.packages["node_modules/alpha"].version;
  f.lock.packages["node_modules/alpha"].name = "@invalid";
  const report = inspectNpmLock(input(f));
  assert.equal(report.completeness.status, "incomplete");
  assert.ok(report.issues.some((i) => i.code === "missing-package-identity"));
  assert.ok(report.issues.some((i) => i.code === "invalid-schema"));
});

it("refuses an unsupported lockfileName at runtime instead of labelling it as a supported lockfile", () => {
  for (const lockfileName of [
    "yarn.lock",
    "node_modules/.package-lock.json",
    "../package-lock.json",
    null,
    3,
  ]) {
    // Exercise the JavaScript boundary without changing the declared TypeScript input contract.
    const report = Reflect.apply(inspectNpmLock, undefined, [{ ...input(), lockfileName }]);
    assert.equal(report.completeness.status, "incomplete");
    assert.equal(report.lockfileName, null);
    assert.equal(report.lockfileVersion, null);
    assert.deepEqual(report.packages, []);
    assert.ok(report.issues.some((i: { code: string }) => i.code === "unsupported-lockfile-name"));
    assert.equal(report.verification, "not-performed");
  }
});

it("bounds workspace matching and rejects overlong package locations", () => {
  const f = fixture();
  const patterns = Array.from({ length: 129 }, (_, i) => `packages/p${i}`);
  f.lock.packages[""].workspaces = patterns;
  const report = inspectNpmLock({
    ...input(f),
    manifest: bytes({ ...f.manifest, workspaces: patterns }),
  });
  assert.ok(report.issues.some((i) => i.code === "input-limit"));
  assert.equal(report.completeness.status, "incomplete");
  const long = fixture();
  long.lock.packages["a/".repeat(2100) + "node_modules/alpha"] =
    long.lock.packages["node_modules/alpha"];
  const location = inspectNpmLock(input(long));
  assert.ok(location.issues.some((i) => i.code === "invalid-package-path"));
  assert.equal(location.completeness.status, "incomplete");
});

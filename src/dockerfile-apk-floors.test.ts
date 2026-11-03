/**
 * The pure half of the apk-floor check: Dockerfile parsing, secdb and APKINDEX parsing, and the
 * comparison. The libexpat case is the one that shipped: a floor of 2.8.5-r0 while Alpine had
 * fixed CVEs in 2.9.0-r0 and 2.10.0-r0.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  alpineBranchOf,
  apkIndexText,
  judgeFloors,
  newestStableBranch,
  parseApkFloors,
  parseApkIndexOrigins,
  parseSecdb,
} from "./dockerfile-apk-floors.js";
import { tarOf } from "./apk-index.test-support.js";

const DOCKERFILE = [
  "FROM node:22-alpine@sha256:abc AS base",
  "FROM base AS runtime",
  "# a comment",
  "RUN apk add --no-cache --upgrade \\",
  "        'bash>=5.3.9-r1' \\",
  "        'libexpat>=2.8.5-r0' \\",
  "        curl \\",
  "    && npm install -g npm@11.21.1",
  "FROM debian:12",
  "RUN apk add 'ignored>=1.0'",
  "FROM alpine:3.22.1",
  "RUN apk add --virtual .deps 'zlib=1.3.1-r0' 'musl<2'",
].join("\n");

describe("dockerfile apk floors: parsing", () => {
  it("names the Alpine branch of a base image when its tag says it", () => {
    assert.deepEqual(alpineBranchOf("alpine:3.22.1"), { kind: "branch", branch: "v3.22" });
    assert.deepEqual(alpineBranchOf("node:22-alpine3.21@sha256:x"), {
      kind: "branch",
      branch: "v3.21",
    });
    assert.deepEqual(alpineBranchOf("alpine:edge"), { kind: "branch", branch: "edge" });
    assert.deepEqual(alpineBranchOf("node:22-alpine"), { kind: "latest" });
    assert.deepEqual(alpineBranchOf("registry:5000/alpine"), { kind: "latest" });
    assert.deepEqual(alpineBranchOf("debian:12"), { kind: "none" });
  });

  it("reads lower-bound floors per stage and skips non-Alpine stages and option values", () => {
    const floors = parseApkFloors(DOCKERFILE).map((f) => [f.name, f.op, f.version, f.branch.kind]);
    assert.deepEqual(floors, [
      ["bash", ">=", "5.3.9-r1", "latest"],
      ["libexpat", ">=", "2.8.5-r0", "latest"],
      ["zlib", "=", "1.3.1-r0", "branch"],
    ]);
  });
});

describe("dockerfile apk floors: secdb and APKINDEX", () => {
  it("reads secdb fixes per origin package", () => {
    const fixes = parseSecdb({
      packages: [{ pkg: { name: "expat", secfixes: { "2.10.0-r0": ["CVE-2026-117610"] } } }],
    });
    assert.deepEqual(fixes.get("expat")?.get("2.10.0-r0"), ["CVE-2026-117610"]);
    assert.throws(() => parseSecdb({}), /no packages/);
  });

  it("maps a subpackage to its origin through a gzipped APKINDEX", () => {
    const index = "P:libexpat\nV:2.10.0-r0\no:expat\n\nP:bash\nV:5.3.9-r1\no:bash\n";
    const gz = Buffer.concat([
      gzipSync(tarOf({ ".SIGN.RSA.key.pub": "sig" })),
      gzipSync(tarOf({ DESCRIPTION: "v3.24", APKINDEX: index })),
    ]);
    const origins = parseApkIndexOrigins(apkIndexText(gz));
    assert.equal(origins.get("libexpat"), "expat");
    assert.throws(() => apkIndexText(gzipSync(tarOf({ other: "x" }))), /no APKINDEX/);
  });

  it("picks the newest stable branch from the secdb index", () => {
    const html = '<a href="edge/">edge/</a><a href="v3.9/">v3.9/</a><a href="v3.24/">v3.24/</a>';
    assert.equal(newestStableBranch(html), "v3.24");
    assert.equal(newestStableBranch("nothing"), null);
  });
});

describe("dockerfile apk floors: judging", () => {
  const secfixes = parseSecdb({
    packages: [
      {
        pkg: {
          name: "expat",
          secfixes: {
            "2.8.5-r0": ["CVE-2026-93990"],
            "2.10.0-r0": ["CVE-2026-117610", "CVE-2026-118370"],
            "2.9.0-r0": ["CVE-2026-102633"],
            "0": ["CVE-2026-1"],
          },
        },
      },
    ],
  });
  const origins = new Map([["libexpat", "expat"]]);
  const floor = (version: string) => [
    { name: "libexpat", op: ">=", version, branch: { kind: "latest" as const } },
  ];

  it("flags the floor that shipped, with every CVE fixed above it and the floor to raise to", () => {
    const { findings } = judgeFloors(floor("2.8.5-r0"), "v3.24", secfixes, origins);
    assert.deepEqual(findings, [
      {
        name: "libexpat",
        floor: "2.8.5-r0",
        fixedIn: "2.10.0-r0",
        cves: ["CVE-2026-102633", "CVE-2026-117610", "CVE-2026-118370"],
        branch: "v3.24",
      },
    ]);
  });

  it("passes a floor at the newest fix, and ignores the '0' (unfixed) entry", () => {
    assert.deepEqual(judgeFloors(floor("2.10.0-r0"), "v3.24", secfixes, origins).findings, []);
  });

  it("reports a floor it cannot compare instead of passing it", () => {
    const judged = judgeFloors(floor("${VER}"), "v3.24", secfixes, origins);
    assert.deepEqual(judged.findings, []);
    assert.deepEqual(judged.unparsed, ["libexpat>=${VER}"]);
  });
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  collectImages,
  configuredImages,
  findDockerfiles,
  imageScanners,
  isSafeImageRef,
  parseDockerfileImages,
} from "./image-scan.js";
import { airGapScanners } from "./scanners.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("isSafeImageRef", () => {
  it("accepts tags, digests, registries with a port and paths", () => {
    for (const ref of [
      "node:22-alpine",
      "nginx",
      "ghcr.io/org/app:1.2.3",
      "registry.example:5000/team/app:1.2",
      `node@sha256:${"a".repeat(64)}`,
    ]) {
      assert.equal(isSafeImageRef(ref), true, ref);
    }
  });

  it("rejects anything that could be read as an option or a second argument", () => {
    for (const ref of [
      "",
      "-x",
      "--config=evil",
      "a b",
      "node:22;rm",
      "http://x/y",
      "node\u001b[2J",
      "a".repeat(300),
      "a\nb",
    ]) {
      assert.equal(isSafeImageRef(ref), false, JSON.stringify(ref));
    }
  });
});

describe("parseDockerfileImages", () => {
  it("finds the image of every stage, keeping the stage order and dropping duplicates", () => {
    const got = parseDockerfileImages(
      "FROM node:22-alpine AS build\nFROM nginx:1.27\nFROM node:22-alpine\n",
    );
    assert.deepEqual(got.images, ["node:22-alpine", "nginx:1.27"]);
  });

  it("reads lowercase, flags, comments and line continuations", () => {
    const text = "# base\nfrom --platform=linux/amd64 \\\n  node:22 as build\n\nFROM build\n";
    assert.deepEqual(parseDockerfileImages(text).images, ["node:22"]);
  });

  it("does not treat scratch or an earlier stage name as an image", () => {
    const got = parseDockerfileImages("FROM golang:1.23 AS build\nFROM scratch\nFROM build\n");
    assert.deepEqual(got.images, ["golang:1.23"]);
    assert.deepEqual(got.skipped, []);
  });

  it("resolves an ARG default, in both ${NAME} and $NAME form", () => {
    const text = "ARG BASE=node:22\nFROM ${BASE}\nARG TWO=nginx:1.27\nFROM $TWO\n";
    assert.deepEqual(parseDockerfileImages(text).images, ["node:22", "nginx:1.27"]);
  });

  it("reports an unresolved ARG instead of scanning a guess", () => {
    const got = parseDockerfileImages("ARG BASE\nFROM ${BASE}\n");
    assert.deepEqual(got.images, []);
    assert.match(got.skipped[0].reason, /unresolved/);
  });

  it("reports an unsafe reference and does not return it", () => {
    const got = parseDockerfileImages("FROM --evil\nFROM node:22;rm\n");
    assert.deepEqual(got.images, []);
    assert.ok(got.skipped.length >= 1);
  });
});

describe("findDockerfiles and collectImages", () => {
  function inProject(files: Record<string, string>, body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "kit-image-scan-"));
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

  it("finds Dockerfile, Dockerfile.*, *.Dockerfile and Containerfile, but not vendored folders", () =>
    inProject(
      {
        Dockerfile: "FROM a:1\n",
        "svc/Dockerfile.prod": "FROM b:1\n",
        "svc/web.Dockerfile": "FROM c:1\n",
        Containerfile: "FROM d:1\n",
        "node_modules/x/Dockerfile": "FROM evil:1\n",
        "README.md": "x",
      },
      (dir) => {
        assert.deepEqual(findDockerfiles(dir), [
          "Containerfile",
          "Dockerfile",
          "svc/Dockerfile.prod",
          "svc/web.Dockerfile",
        ]);
      },
    ));

  it("does not follow a symlinked Dockerfile", () =>
    inProject({ "real.txt": "FROM secret:1\n" }, (dir) => {
      symlinkSync(join(dir, "real.txt"), join(dir, "Dockerfile"));
      assert.deepEqual(findDockerfiles(dir), []);
    }));

  it("lists configured images first, then Dockerfile images when asked, deduplicated", () =>
    inProject({ Dockerfile: "FROM node:22\nFROM nginx:1.27\n" }, (dir) => {
      const got = collectImages(dir, {
        configured: ["nginx:1.27", "redis:7"],
        fromDockerfiles: true,
      });
      assert.deepEqual(
        got.images.map((i) => i.ref),
        ["nginx:1.27", "redis:7", "node:22"],
      );
      assert.equal(got.images[0].source, "[scan].images");
      assert.equal(got.images[2].source, "Dockerfile");
    }));

  it("reads no Dockerfile unless asked", () =>
    inProject({ Dockerfile: "FROM node:22\n" }, (dir) => {
      assert.deepEqual(collectImages(dir, { configured: [], fromDockerfiles: false }).images, []);
    }));

  it("reports an unsafe configured reference and a Dockerfile it could not read", () =>
    inProject({}, (dir) => {
      const got = collectImages(dir, { configured: ["-bad", "ok:1"], fromDockerfiles: false });
      assert.deepEqual(
        got.images.map((i) => i.ref),
        ["ok:1"],
      );
      assert.match(got.skipped[0].reason, /not a valid image reference/);
    }));
});

describe("imageScanners", () => {
  const images = [{ ref: "ghcr.io/org/app:1.2", source: "[scan].images" }];

  it("builds one osv-scanner and one trivy run per image, from the image itself and never from a shell", () => {
    const defs = imageScanners(images);
    assert.deepEqual(
      defs.map((d) => [d.id, d.bin, d.args, d.format]),
      [
        [
          "osv-scanner:image:ghcr.io/org/app:1.2",
          "osv-scanner",
          ["scan", "image", "--format", "json", "ghcr.io/org/app:1.2"],
          "osv",
        ],
        [
          "trivy:image:ghcr.io/org/app:1.2",
          "trivy",
          ["image", "--format", "sarif", "--quiet", "ghcr.io/org/app:1.2"],
          "sarif",
        ],
      ],
    );
  });

  it("respects the [scan].delegates allow-list", () => {
    assert.deepEqual(
      imageScanners(images, ["trivy"]).map((d) => d.bin),
      ["trivy"],
    );
    assert.deepEqual(imageScanners(images, ["snyk"]), []);
  });

  it("marks every run as needing the network and gives it a long timeout", () => {
    for (const d of imageScanners(images)) {
      assert.equal(d.cloudOnly, true);
      assert.ok((d.timeoutMs ?? 0) >= 300_000);
    }
  });

  it("is dropped in air gap with its ids named", () => {
    const plan = airGapScanners(imageScanners(images), true);
    assert.deepEqual(plan.scanners, []);
    assert.equal(plan.dropped.length, 2);
  });
});

describe("configuredImages", () => {
  it("returns the strings of a list", () => {
    assert.deepEqual(configuredImages(["a:1", "b:2"]), ["a:1", "b:2"]);
  });

  it("returns nothing for a value that is not a list, instead of reading a string character by character", () => {
    for (const bad of ["node:22", 5, true, null, undefined, { a: 1 }]) {
      assert.deepEqual(configuredImages(bad), [], String(bad));
    }
  });

  it("drops the items of a list that are not strings", () => {
    assert.deepEqual(configuredImages(["a:1", 2, null, "b:2"]), ["a:1", "b:2"]);
  });
});

describe("skipped references carry no terminal control characters", () => {
  const ESC = String.fromCharCode(27);

  it("cleans a skipped Dockerfile reference", () => {
    const got = parseDockerfileImages(`FROM node:22${ESC}[2J;rm\n`);
    assert.equal(got.skipped.length, 1);
    assert.ok(!got.skipped[0].ref.includes(ESC));
  });

  it("cleans an unresolved ARG reference", () => {
    const got = parseDockerfileImages(`ARG BASE\nFROM \${BASE}${ESC}[2J\n`);
    assert.equal(got.skipped.length, 1);
    assert.ok(!got.skipped[0].ref.includes(ESC));
  });

  it("cleans a skipped configured reference", () => {
    const got = collectImages("/nonexistent", {
      configured: [`-bad${ESC}[2J`],
      fromDockerfiles: false,
    });
    assert.ok(!got.skipped[0].ref.includes(ESC));
  });

  it(
    "ignores a Dockerfile in a folder whose name has control characters",
    { skip: process.platform === "win32" },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "kit-image-scan-"));
      try {
        const evil = join(dir, `svc${ESC}[2J`);
        mkdirSync(evil);
        writeFileSync(join(evil, "Dockerfile"), "FROM a:1\n");
        assert.deepEqual(findDockerfiles(dir), []);
      } finally {
        rmTemp(dir);
      }
    },
  );
});

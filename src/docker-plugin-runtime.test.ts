import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Docker plugin runtime", () => {
  it("pins every Node base image to the reviewed multi-architecture manifest", async () => {
    const dockerfile = await readFile(resolve(repoRoot, "Dockerfile"), "utf-8");
    const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM node:"));

    // builder, prod-deps, runtime
    assert.equal(fromLines.length, 3);
    for (const line of fromLines) {
      assert.match(
        line,
        /^FROM node:22-alpine@sha256:[a-f0-9]{64}(?: AS (?:builder|prod-deps))?$/,
      );
    }
  });

  it("retains every executable and asset required by triage-gated plugin installs", async () => {
    const dockerfile = await readFile(resolve(repoRoot, "Dockerfile"), "utf-8");
    const builder = dockerfile.slice(0, dockerfile.lastIndexOf("FROM node:22-alpine@sha256:"));
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM node:22-alpine@sha256:"));

    assert.match(builder, /COPY skills \.\/skills/);
    assert.match(runtime, /apk add[^\n\\]*(?:\\\n[^\n]*)*\bpython3\b/);
    assert.match(runtime, /npm\s+install\s+-g\s+npm@11\.19\.1\s+--ignore-scripts/);
    assert.match(runtime, /npm\s+cache\s+clean\s+--force/);
    assert.match(runtime, /COPY --from=builder[^\n]*\/build\/skills\s+\.\/skills/);
    assert.match(runtime, /chown\s+kit:kit\s+\/app/);
  });
});

/**
 * MR-1: the runtime stage used to copy the BUILDER's node_modules, which is `npm ci` with
 * devDependencies. The published CLI image therefore shipped typescript, eslint and
 * esbuild: 170 packages, 93.6MB, none of them reachable at runtime, in a 460MB image whose
 * own header claimed "~100MB". kit has four runtime dependencies.
 */
describe("Docker runtime ships production dependencies only (MR-1)", () => {
  const runtimeStage = async (): Promise<{ dockerfile: string; runtime: string }> => {
    const dockerfile = await readFile(resolve(repoRoot, "Dockerfile"), "utf-8");
    return {
      dockerfile,
      runtime: dockerfile.slice(dockerfile.lastIndexOf("FROM node:22-alpine@sha256:")),
    };
  };

  it("resolves the runtime tree from the lockfile without devDependencies", async () => {
    const { dockerfile } = await runtimeStage();
    assert.match(dockerfile, /AS prod-deps/);
    assert.match(dockerfile, /RUN npm ci --omit=dev --ignore-scripts/);
  });

  it("never copies the builder's node_modules into the runtime image", async () => {
    const { runtime } = await runtimeStage();
    assert.match(runtime, /COPY --from=prod-deps[^\n]*\/deps\/node_modules\s+\.\/node_modules/);
    assert.doesNotMatch(
      runtime,
      /COPY --from=builder[^\n]*node_modules/,
      "the builder tree carries devDependencies; the runtime image must not inherit it",
    );
  });

  it("states a measured image size, not an estimate", async () => {
    const { dockerfile } = await runtimeStage();
    const header = dockerfile.slice(0, dockerfile.indexOf("FROM "));
    assert.match(header, /Final image: Node 22 Alpine, \d+MB \(arm64, `docker images`\)/);
    assert.doesNotMatch(header, /Final image[^\n]*~/);
  });
});

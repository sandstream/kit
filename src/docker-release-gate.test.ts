import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github", "workflows", "docker-build.yml"), "utf8");
const lines = workflow.split("\n");

function step(name: string): { start: number; body: string; run: string } {
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.ok(start >= 0, `missing workflow step ${name}`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("      - name: ")) end++;
  const block = lines.slice(start, end);
  const runStart = block.findIndex((line) => line === "        run: |");
  const runLines: string[] = [];
  if (runStart >= 0) {
    for (const line of block.slice(runStart + 1)) {
      if (line && !line.startsWith("          ")) break;
      runLines.push(line.slice(10));
    }
  }
  const run = runLines.join("\n");
  return { start, body: block.join("\n"), run };
}

function assertBuildScanPush(): void {
  const build = step("Build CLI image locally");
  const scan = step("Image vulnerability scan");
  const upload = step("Upload Trivy scan results");
  const push = step("Push scanned CLI image");
  const sign = step("Sign CLI image (keyless)");
  const sbom = step("Generate SBOM for CLI image");
  const attest = step("Attest CLI image SBOM");
  assert.ok(build.start < scan.start && scan.start < upload.start && upload.start < push.start);
  assert.ok(push.start < sign.start && sign.start < sbom.start && sbom.start < attest.start);
  assert.match(build.body, /\n {10}load: true(?:\n|$)/);
  assert.match(build.body, /\n {10}tags: kit:scan(?:\n|$)/);
  assert.doesNotMatch(build.body, /\n {10}push:|type=registry[^\n]*buildcache,mode=max/);
  assert.match(scan.body, /image-ref: kit:scan/);
  assert.ok(scan.body.includes("severity: HIGH,CRITICAL"));
  assert.ok(scan.body.includes('exit-code: "1"'));
  assert.doesNotMatch(scan.body, /continue-on-error/);
  assert.match(upload.body, /!cancelled\(\)/);
  assert.match(upload.body, /continue-on-error: true/);
  assert.ok(push.body.includes("github.event_name != 'pull_request'"));
  assert.ok(push.body.includes("steps.docker-creds.outputs.present == 'true'"));
  assert.ok(push.body.includes("steps.scan.outcome == 'success'"));
  for (const row of [sign, sbom, attest]) {
    assert.match(row.body, /steps\.push-cli\.outputs\.digest/);
    assert.doesNotMatch(row.body, /steps\.build-cli\.outputs\.digest/);
  }
}

function writeDockerMock(dir: string): string {
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALL_LOG"\n' +
      'if [ "$1" = "buildx" ]; then\n' +
      '  if [ "${DIVERGE:-}" = "1" ] && [ "$4" = "docker.io/sandstream/kit:sha-123" ]; then\n' +
      '    printf "sha256:%064d\\n" 2\n' +
      "  else\n" +
      '    printf "sha256:%064d\\n" 1\n' +
      "  fi\n" +
      "fi\n",
  );
  chmodSync(docker, 0o755);
  return docker;
}

function runDockerPush(dir: string, output: string, log: string, diverge = false) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", step("Push scanned CLI image").run], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      TAGS: "docker.io/sandstream/kit:main\ndocker.io/sandstream/kit:sha-123",
      DOCKER_CALL_LOG: log,
      GITHUB_OUTPUT: output,
      ...(diverge ? { DIVERGE: "1" } : {}),
    },
  });
}

describe("Docker image release gate (CI-08)", () => {
  it("attempts registry login only when both credentials are configured", () => {
    const credentials = step("Check Docker Hub creds present");
    assert.match(credentials.body, /DOCKER_USERNAME: \$\{\{ secrets\.DOCKER_USERNAME \}\}/);
    assert.match(credentials.body, /DOCKER_PASSWORD: \$\{\{ secrets\.DOCKER_PASSWORD \}\}/);
    assert.match(credentials.run, /\[ -n "\$DOCKER_USERNAME" \] && \[ -n "\$DOCKER_PASSWORD" \]/);
  });

  it("loads one image, scans high and critical findings, then allows publication", () => {
    assert.match(workflow, /push:\n {4}branches:\n {6}- main\n {4}tags:\n {6}- "v\*"/);
    assert.match(workflow, /pull_request:\n {4}branches:\n {6}- main/);
    assertBuildScanPush();
    const smoke = step("Test CLI image");
    assert.match(smoke.body, /github\.event_name == 'pull_request'/);
    assert.match(smoke.body, /docker run --rm kit:scan --version/);
    assert.match(smoke.body, /docker run --rm kit:scan --help/);
    const comment = step("Comment PR with image details");
    assert.match(
      comment.body,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
  });

  it(
    "pushes every metadata tag from the scanned local image and checks one registry digest",
    {
      skip: process.platform === "win32",
    },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "kit-docker-push-test-"));
      try {
        const log = join(dir, "calls.log");
        const output = join(dir, "github-output");
        writeDockerMock(dir);
        const run = runDockerPush(dir, output, log);
        assert.equal(run.status, 0, run.stderr);
        const calls = readFileSync(log, "utf8");
        assert.match(calls, /tag kit:scan docker\.io\/sandstream\/kit:main/);
        assert.match(calls, /push docker\.io\/sandstream\/kit:main/);
        assert.match(calls, /tag kit:scan docker\.io\/sandstream\/kit:sha-123/);
        assert.match(calls, /push docker\.io\/sandstream\/kit:sha-123/);
        assert.match(readFileSync(output, "utf8"), /^digest=sha256:[a-f0-9]{64}\n$/);

        writeFileSync(output, "");
        const mismatch = runDockerPush(dir, output, log, true);
        assert.equal(mismatch.status, 1);
        assert.match(mismatch.stderr, /different image digests/);
        assert.equal(readFileSync(output, "utf8"), "");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("Docker failed scan diagnostics", () => {
  it("reports failed scan findings from SARIF without echoing untrusted details", () => {
    const scan = step("Image vulnerability scan");
    const explain = step("Explain failed image scan");
    const push = step("Push scanned CLI image");
    assert.ok(scan.start < explain.start && explain.start < push.start);
    assert.match(explain.body, /!cancelled\(\).*steps\.scan\.outcome == 'failure'/);
    const dir = mkdtempSync(join(tmpdir(), "kit-trivy-diagnostic-test-"));
    try {
      writeFileSync(
        join(dir, "trivy-results.sarif"),
        JSON.stringify({
          runs: [
            {
              results: [
                {
                  ruleId: "CVE-2026-12345",
                  message: { text: "::error::secret content" },
                  locations: [
                    { physicalLocation: { artifactLocation: { uri: "pkg:apk/alpine/libssl3" } } },
                  ],
                },
                {
                  ruleId: "GHSA-abcd-1234-wxyz\n::error::injected",
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: "node_modules/evil\n::error::injected" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
      const run = spawnSync("bash", ["-euo", "pipefail", "-c", explain.run], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /Trivy SARIF: 2 finding\(s\)/);
      assert.match(run.stdout, /CVE-2026-12345.*pkg:apk\/alpine\/libssl3/);
      assert.doesNotMatch(run.stdout, /secret content|\n::error::/);
      assert.equal(run.stdout.split("\n").filter((line) => line.includes("::error::")).length, 0);

      rmSync(join(dir, "trivy-results.sarif"));
      const missing = spawnSync("bash", ["-euo", "pipefail", "-c", explain.run], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(missing.status, 0, missing.stderr);
      assert.match(missing.stdout, /SARIF unavailable/);

      writeFileSync(join(dir, "trivy-results.sarif"), "not SARIF");
      const malformed = spawnSync("bash", ["-euo", "pipefail", "-c", explain.run], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(malformed.status, 0, malformed.stderr);
      assert.match(malformed.stdout, /SARIF unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

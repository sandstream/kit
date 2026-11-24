import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDockerIocs, parseImageList, matchIocs } from "./check-docker-ioc.js";
import { ruleForCheck } from "./rules/catalog.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

const INDEX = "sha256:ce85d8369ccc1a85423f1f75d2f3afaa2fab759e580da37a6891af2f7392745e";
const AMD64 = "sha256:cb85a7206290dc1813e3203e044741054b26c7a7c557c7d9d6d91af20aeb232b";
const CLEAN = "sha256:" + "a".repeat(64);
const makeRow = (
  Repository: string,
  Tag: string,
  Digest: string,
  ID = "sha256:" + "9".repeat(64),
) => JSON.stringify({ Containers: "N/A", Repository, Tag, Digest, ID, Size: "1GB" }) + "\n";
const success = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0, ok: true });

function lister(listing: ExecResult, count = success("1\n")) {
  return async (args: string[], timeout: number) => {
    assert.ok(timeout > 0 && timeout <= 15_000);
    if (args[0] === "info") {
      assert.deepEqual(args.slice(1), ["--format", "{{json .Images}}"]);
      return count;
    }
    assert.deepEqual(args, [
      "image",
      "ls",
      "--all",
      "--digests",
      "--no-trunc",
      "--format",
      "{{json .}}",
    ]);
    return listing;
  };
}

describe("check Docker image indicators against the selected inventory", () => {
  it("reconciles image aliases with the daemon count", async () => {
    const rows = makeRow("qdrant/qdrant", "latest", CLEAN) + makeRow("qdrant/qdrant", "v1", CLEAN);
    const r = await checkDockerIocs(lister(success(rows)));
    assert.equal(r.status, "pass");
    assert.equal(r.evidenceStatus, "complete-empty");
    assert.match(r.detail, /2 image row\(s\).*3 published indicators/);
    assert.match(r.detail, /does not scan image content/);
  });

  it("fails on the flagged repository name, with its source", async () => {
    const r = await checkDockerIocs(lister(success(makeRow("tomicdd/artex", "latest", "<none>"))));
    assert.equal(r.status, "fail");
    assert.equal(r.evidenceStatus, "complete");
    assert.equal(r.severity, "critical");
    assert.match(r.detail, /tomicdd\/artex:latest matches repository tomicdd\/artex/);
    assert.match(r.detail, /Source darkfibr\/artex-forensics evidence\/iocs\.csv at ec0389cf/);
    assert.match(r.suggestion ?? "", /docker image rm sha256:9{64}/);
  });

  it("fails on a flagged index digest under a different name", async () => {
    const r = await checkDockerIocs(lister(success(makeRow("example/image", "v1", INDEX))));
    assert.equal(r.status, "fail");
    assert.match(r.detail, /example\/image:v1 matches digest sha256:ce85/);
  });

  it("matches an uppercase digest and Docker Hub repository alias", () => {
    const row = makeRow("docker.io/TomicDD/Artex", "<none>", AMD64.toUpperCase()).replace(
      "\n",
      "\r\n",
    );
    const { images, malformed } = parseImageList(row);
    assert.equal(malformed, 0);
    assert.deepEqual(
      matchIocs(images)
        .map((match) => match.ioc.kind)
        .sort(),
      ["digest", "repository"],
    );
  });

  it("cites a CWE for the row", () => {
    assert.equal(ruleForCheck("local docker image IOCs")?.id, "CWE-506");
  });
});

describe("Docker row validation keeps findings with partial coverage", () => {
  it("counts malformed input and keeps the recognized rows", () => {
    const { images, malformed } = parseImageList(
      "not json\n[1,2]\nnull\n" + makeRow("a/b", "1", CLEAN),
    );
    assert.deepEqual(
      images.map((image) => image.repository),
      ["a/b"],
    );
    assert.equal(malformed, 3);
  });

  it("retains a digest finding without printing invalid labels or IDs", async () => {
    const row = makeRow("invalid\nPASS\u001b[2J", "t", INDEX, "invalid ID");
    const r = await checkDockerIocs(lister(success(row)));
    assert.equal(r.status, "fail");
    assert.equal(r.evidenceStatus, "partial");
    assert.equal(r.hasFindings, true);
    assert.doesNotMatch(r.detail, /invalid ID|PASS|[\n\u001b]/);
    assert.doesNotMatch(r.suggestion ?? "", /invalid ID/);
  });

  it("reports an incomplete report with a usable final row and retains its finding", async () => {
    const row = makeRow("example/image", "v1", INDEX).trimEnd();
    const r = await checkDockerIocs(lister(success(row)));
    assert.equal(r.status, "fail");
    assert.equal(r.evidenceStatus, "partial");
  });

  it("retains image findings from a failed process with partial stdout", async () => {
    const output = { ...success(makeRow("example/image", "v1", INDEX)), ok: false, exitCode: 7 };
    const r = await checkDockerIocs(lister(output));
    assert.equal(r.status, "fail");
    assert.equal(r.evidenceStatus, "partial");
    assert.equal(r.hasFindings, true);
  });
});

describe("Docker inventory scope and process status", () => {
  it("reports an optional skip when the Docker CLI is absent", async () => {
    const r = await checkDockerIocs(
      lister({
        ...success(""),
        ok: false,
        exitCode: 1,
        noNumericExitStatus: true,
        didNotStart: true,
        spawnErrorCode: "ENOENT",
      }),
    );
    assert.equal(r.status, "skip");
    assert.equal(r.evidenceStatus, "missing");
    assert.equal(r.didNotRun, undefined);
  });

  it("reports an optional skip for the native daemon connection error", async () => {
    const stderr =
      "Cannot connect to the Docker daemon at unix:///tmp/fixture.sock. Is the docker daemon running?\n";
    const r = await checkDockerIocs(lister({ stdout: "", stderr, exitCode: 1, ok: false }));
    assert.equal(r.status, "skip");
    assert.equal(r.evidenceStatus, "missing");
  });

  it("distinguishes a missing Docker socket from a permission failure", async () => {
    const diagnostic =
      "failed to connect to the docker API at unix:///tmp/docker.sock; check if the path is correct and if the daemon is running: dial unix /tmp/docker.sock: connect: ";
    const listing = { stdout: "", exitCode: 1, ok: false };
    const missing = await checkDockerIocs(
      lister({ ...listing, stderr: diagnostic + "no such file or directory\n" }),
    );
    const denied = await checkDockerIocs(
      lister({ ...listing, stderr: diagnostic + "permission denied\n" }),
    );
    assert.equal(missing.status, "skip");
    assert.equal(missing.evidenceStatus, "missing");
    assert.equal(denied.status, "warn");
    assert.equal(denied.evidenceStatus, "unavailable");
  });
});

describe("Windows Docker pipe status", () => {
  it("recognizes a missing Windows Docker pipe without masking access errors", async () => {
    const diagnostics = [
      'error during connect: this error may indicate that the docker daemon is not running: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.48/images/json": open //./pipe/docker_engine: ',
      'error during connect: in the default daemon configuration on Windows, the docker client must be run with elevated privileges to connect: Head "http://%2F%2F.%2Fpipe%2Fdocker_engine/_ping": open //./pipe/docker_engine: ',
      "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: ",
    ];
    const absent = "The system cannot find the file specified.\r\n";
    const listing = { stdout: "", exitCode: 1, ok: false };

    for (const diagnostic of diagnostics) {
      const missing = await checkDockerIocs(lister({ ...listing, stderr: diagnostic + absent }));
      assert.equal(missing.status, "skip", diagnostic);
      assert.equal(missing.evidenceStatus, "missing");

      const denied = await checkDockerIocs(
        lister({ ...listing, stderr: diagnostic + "Access is denied.\r\n" }),
      );
      assert.equal(denied.status, "warn");
      assert.equal(denied.evidenceStatus, "unavailable");
    }

    const partial = await checkDockerIocs(
      lister({
        ...listing,
        stdout: makeRow("example/image", "v1", CLEAN),
        stderr: diagnostics[0] + absent,
      }),
    );
    assert.equal(partial.evidenceStatus, "partial");
  });
});

describe("Docker inventory failures", () => {
  it("reports generic errors instead of treating the Docker scope as absent", async () => {
    const r = await checkDockerIocs(
      lister({ stdout: "", stderr: "permission denied", exitCode: 1, ok: false }),
    );
    assert.equal(r.status, "warn");
    assert.equal(r.evidenceStatus, "unavailable");
    assert.equal(r.didNotRun, true);
    assert.doesNotMatch(r.detail, /permission denied/);
  });
});

describe("Docker count confirms complete findings evidence", () => {
  it("allows genuine empty evidence only with a confirmed zero count", async () => {
    const empty = await checkDockerIocs(lister(success(""), success("0\n")));
    assert.equal(empty.status, "pass");
    assert.equal(empty.evidenceStatus, "complete-empty");

    const omitted = await checkDockerIocs(lister(success(""), success("1\n")));
    assert.equal(omitted.status, "warn");
    assert.equal(omitted.evidenceStatus, "partial");

    const noCount = await checkDockerIocs(lister(success(""), success("")));
    assert.equal(noCount.status, "warn");
    assert.equal(noCount.evidenceStatus, "missing");
  });

  it("does not report clean when listing could not be reconciled", async () => {
    const valid = success(makeRow("example/image", "v1", CLEAN));
    const countMismatch = await checkDockerIocs(lister(valid, success("2\n")));
    const diagnostic = await checkDockerIocs(lister({ ...valid, stderr: "diagnostic" }));
    const malformed = await checkDockerIocs(lister(success("garbage\n")));
    assert.equal(countMismatch.evidenceStatus, "partial");
    assert.equal(diagnostic.evidenceStatus, "partial");
    assert.equal(malformed.evidenceStatus, "malformed");
    assert.equal(malformed.didNotRun, true);
  });
});

/**
 * The `local docker image IOCs` row of `kit check`: local images, as `docker image ls --digests
 * --format '{{json .}}'` prints them, compared with the published IOCs in docker-ioc-data.ts.
 * The lister is injected, so no test starts docker; one test runs the real default lister only to
 * show that a machine without docker (or its daemon) skips with a plain line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDockerIocs, parseImageList, matchIocs } from "./check-docker-ioc.js";
import { ruleForCheck } from "./rules/catalog.js";

const INDEX = "sha256:ce85d8369ccc1a85423f1f75d2f3afaa2fab759e580da37a6891af2f7392745e";
const AMD64 = "sha256:cb85a7206290dc1813e3203e044741054b26c7a7c557c7d9d6d91af20aeb232b";
const CLEAN = "sha256:" + "a".repeat(64);
const row = (Repository: string, Tag: string, Digest: string, ID = "sha256:" + "9".repeat(64)) =>
  JSON.stringify({ Containers: "N/A", Repository, Tag, Digest, ID, Size: "1GB" });
const lister = (stdout: string) => async (args: string[]) => {
  assert.deepEqual(args.slice(0, 3), ["image", "ls", "--digests"]);
  return stdout;
};

describe("check-docker-ioc: matching", () => {
  it("passes when no local image matches, and says it is not a scan", async () => {
    const r = await checkDockerIocs(lister([row("qdrant/qdrant", "latest", CLEAN)].join("\n")));
    assert.equal(r.status, "pass");
    assert.match(r.detail, /1 local image row\(s\) compared with 3 published image IOC\(s\)/);
    assert.match(r.detail, /not a malware scan/);
  });

  it("fails on the backdoored repository name, with its source", async () => {
    const r = await checkDockerIocs(lister(row("tomicdd/artex", "latest", "<none>")));
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
    assert.match(r.detail, /tomicdd\/artex:latest matches repository tomicdd\/artex/);
    assert.match(r.detail, /source: darkfibr\/artex-forensics evidence\/iocs\.csv at ec0389cf/);
    assert.match(r.suggestion ?? "", /docker image rm sha256:9{64}/);
  });

  it("fails on the index digest under another name (a retag does not hide it)", async () => {
    const r = await checkDockerIocs(lister(row("example/innocent", "v1", INDEX)));
    assert.equal(r.status, "fail");
    assert.match(r.detail, /example\/innocent:v1 matches digest sha256:ce85/);
  });

  it("matches the amd64 manifest digest and a docker.io-prefixed name without case", () => {
    const images = parseImageList(
      [
        row("docker.io/TomicDD/Artex", "<none>", AMD64.toUpperCase().replace("SHA256", "sha256")),
      ].join("\r\n"),
    );
    const kinds = matchIocs(images)
      .map((m) => m.ioc.kind)
      .sort();
    assert.deepEqual(kinds, ["digest", "repository"]);
  });

  it("ignores lines that are not image rows", () => {
    const images = parseImageList(
      ["", "not json", "[1,2]", "null", row("a/b", "1", CLEAN)].join("\n"),
    );
    assert.deepEqual(
      images.map((i) => i.repository),
      ["a/b"],
    );
  });

  it("prints an attacker-chosen name as one printable line", async () => {
    const r = await checkDockerIocs(lister(row("x\nPASS\u001b[2J", "t", INDEX)));
    assert.equal(r.status, "fail");
    assert.doesNotMatch(r.detail, /[\n\u001b]/);
  });

  it("cites a CWE for the row", () => {
    assert.equal(ruleForCheck("local docker image IOCs")?.id, "CWE-506");
  });
});

describe("check-docker-ioc: no docker", () => {
  it("skips with a plain line when the docker CLI is absent", async () => {
    const r = await checkDockerIocs(async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    });
    assert.equal(r.status, "skip");
    assert.equal(r.didNotRun, undefined);
    assert.equal(r.detail, "docker CLI not installed; no local images to compare");
  });

  it("skips when the daemon does not answer", async () => {
    const r = await checkDockerIocs(async () => {
      throw Object.assign(new Error("Command failed"), { code: 1 });
    });
    assert.equal(r.status, "skip");
    assert.match(r.detail, /daemon not running or not reachable/);
  });
});

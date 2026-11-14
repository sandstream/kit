import assert from "node:assert/strict";
import { it } from "node:test";
import { fetchAndInspectNpmArtifact } from "./npm-artifact.js";
import { artifactVectors } from "./npm-artifact.test-support.js";
import { withHttps } from "./npm-artifact-fetch.test-support.js";

it("fetches the exact selected archive over real TLS and verifies its manifest and compressed digest", async () => {
  const vector = artifactVectors.valid;
  const requests: { url: string | undefined; encoding: string | string[] | undefined }[] = [];
  await withHttps(
    (request, response) => {
      requests.push({ url: request.url, encoding: request.headers["accept-encoding"] });
      response.end(Buffer.from(vector.base64, "base64"));
    },
    async ({ origin, caPem }) => {
      const selected = {
        packagePath: "node_modules/compat",
        name: "@scope/real",
        version: "1.2.3",
        source: "remote-tarball",
        resolved: `${origin}/exact.tgz?value=one%2Ftwo`,
        integrity: vector.integrity,
      };
      const result = await fetchAndInspectNpmArtifact(selected, { origins: [origin], caPem });
      assert.equal(result.status, "verified", JSON.stringify(result));
      if (result.status !== "verified") return;
      assert.deepEqual(result.selection, selected);
      assert.equal(result.integrity.actualDigest, vector.integrity.slice(7));
      assert.equal(result.integrity.byteCount, vector.compressedBytes);
      assert.deepEqual(result.manifest, {
        name: "@scope/real",
        version: "1.2.3",
        scripts: { install: "node install.js" },
      });
    },
  );
  assert.deepEqual(requests, [{ url: "/exact.tgz?value=one%2Ftwo", encoding: "identity" }]);
});

it("preserves the selected identity while the network response is pending", async () => {
  const vector = artifactVectors.valid;
  let selected = {
    packagePath: "node_modules/compat",
    name: "@scope/real",
    version: "1.2.3",
    source: "remote-tarball",
    resolved: "",
    integrity: String(vector.integrity),
  };
  await withHttps(
    (_request, response) => {
      selected.name = "changed";
      selected.integrity = "changed";
      selected.resolved = "https://replacement.invalid/another.tgz";
      response.end(Buffer.from(vector.base64, "base64"));
    },
    async ({ origin, caPem }) => {
      selected = { ...selected, resolved: `${origin}/exact.tgz` };
      const expected = { ...selected };
      const result = await fetchAndInspectNpmArtifact(selected, { origins: [origin], caPem });
      assert.equal(result.status, "verified", JSON.stringify(result));
      if (result.status === "verified") assert.deepEqual(result.selection, expected);
      assert.equal(selected.name, "changed");
    },
  );
});

it("refuses a valid TLS response whose compressed bytes differ from the selected integrity", async () => {
  let requests = 0;
  await withHttps(
    (_request, response) => {
      requests++;
      response.end(Buffer.from(artifactVectors.wrongName.base64, "base64"));
    },
    async ({ origin, caPem }) => {
      const result = await fetchAndInspectNpmArtifact(
        {
          packagePath: "node_modules/compat",
          name: "@scope/real",
          version: "1.2.3",
          source: "remote-tarball",
          resolved: `${origin}/exact.tgz`,
          integrity: artifactVectors.valid.integrity,
        },
        { origins: [origin], caPem },
      );
      assert.deepEqual(result, { status: "rejected", reason: "digest-mismatch" });
    },
  );
  assert.equal(requests, 1);
});

it("refuses unsupported selections and unapproved origins before any request", async () => {
  let requests = 0;
  await withHttps(
    (_request, response) => {
      requests++;
      response.end(Buffer.from(artifactVectors.valid.base64, "base64"));
    },
    async ({ origin, caPem }) => {
      const selected = {
        packagePath: "node_modules/compat",
        name: "@scope/real",
        version: "1.2.3",
        source: "remote-tarball",
        resolved: `${origin}/exact.tgz`,
        integrity: artifactVectors.valid.integrity,
      };
      assert.deepEqual(await fetchAndInspectNpmArtifact(selected, { origins: [], caPem }), {
        status: "rejected",
        reason: "origin-not-allowed",
      });
      assert.deepEqual(
        await fetchAndInspectNpmArtifact(
          { ...selected, source: "git", integrity: null },
          { origins: [origin], caPem },
        ),
        { status: "unsupported", reason: "unsupported-artifact-source" },
      );
      assert.deepEqual(
        await fetchAndInspectNpmArtifact({ ...selected, name: null }, { origins: [origin], caPem }),
        { status: "rejected", reason: "invalid-artifact-selection" },
      );
    },
  );
  assert.equal(requests, 0);
});

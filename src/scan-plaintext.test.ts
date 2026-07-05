import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanPlaintextSecrets } from "./scan-plaintext.js";

function withTmp(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-scan-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const labels = (hits: { file: string; findings: { label: string }[] }[], file: string) =>
  hits.find((h) => h.file === file)?.findings.map((f) => f.label) ?? [];

describe("scanPlaintextSecrets — key-file coverage (B3)", () => {
  it(
    "scans raw private-key files the old globs never opened",
    withTmp(async (dir) => {
      const pem =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END RSA PRIVATE KEY-----\n";
      writeFileSync(join(dir, "id_rsa"), pem);
      writeFileSync(join(dir, "server.pem"), pem);
      writeFileSync(join(dir, "tls.key"), pem);
      const hits = await scanPlaintextSecrets(dir);
      assert.deepEqual(labels(hits, "id_rsa"), ["pem-private-key"]);
      assert.deepEqual(labels(hits, "server.pem"), ["pem-private-key"]);
      assert.deepEqual(labels(hits, "tls.key"), ["pem-private-key"]);
    }),
  );

  it(
    "scans .npmrc for an auth token",
    withTmp(async (dir) => {
      writeFileSync(
        join(dir, ".npmrc"),
        `//registry.npmjs.org/:_authToken=npm_${"a".repeat(36)}\n`,
      );
      assert.deepEqual(labels(await scanPlaintextSecrets(dir), ".npmrc"), ["npm-token"]);
    }),
  );

  it(
    "scans a *.pem inside a recursive config dir",
    withTmp(async (dir) => {
      mkdirSync(join(dir, "infra"));
      writeFileSync(
        join(dir, "infra", "ca.pem"),
        "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n",
      );
      assert.deepEqual(labels(await scanPlaintextSecrets(dir), join("infra", "ca.pem")), [
        "pem-private-key",
      ]);
    }),
  );

  it(
    "still reports nothing for a clean tree (no false positives)",
    withTmp(async (dir) => {
      writeFileSync(join(dir, ".env"), "NODE_ENV=production\nPORT=3000\n");
      writeFileSync(join(dir, "server.pem"), "not actually a key, just a note\n");
      assert.deepEqual(await scanPlaintextSecrets(dir), []);
    }),
  );
});

/**
 * scripts/github-app-token.mjs mints the reviewer App's installation token. The JWT must verify
 * against the App's public key and live at most ten minutes, and the token request must name one
 * repository and only the reviewer's permissions: the key can mint more, the token must not ask.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface TokenScript {
  appJwt(appId: string, pem: string, now?: number): string;
  tokenRequest(repository: string): { repositories: string[]; permissions: Record<string, string> };
  installationToken(env: Record<string, string | undefined>): Promise<string>;
  describeInstallations(repository: string, app: unknown, installations: unknown): string;
}

const load = async () =>
  (await import(
    pathToFileURL(join(REPO_ROOT, "scripts", "github-app-token.mjs")).href
  )) as TokenScript;

describe("github-app-token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("signs an RS256 JWT that verifies and expires within ten minutes", async () => {
    const { appJwt } = await load();
    const jwt = appJwt("123456", pem, 1_000_000);
    const [header, payload, signature] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")));
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    assert.deepEqual(claims, { iat: 999_940, exp: 1_000_540, iss: "123456" });
    assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
  });

  it("rejects an App ID that is neither numeric nor a client ID", async () => {
    const { appJwt } = await load();
    assert.throws(() => appJwt("12; rm -rf", pem), /numeric App ID or a client ID/);
  });

  it("asks for one repository and only the reviewer's permissions", async () => {
    const { tokenRequest } = await load();
    assert.deepEqual(tokenRequest("sandstream/kit"), {
      repositories: ["kit"],
      permissions: { pull_requests: "write", contents: "read" },
    });
    assert.throws(() => tokenRequest("kit"), /owner\/name/);
    assert.throws(() => tokenRequest("a/b/c"), /owner\/name/);
  });

  it("names where the App is installed when this repository is not among them", async () => {
    const { describeInstallations } = await load();
    assert.equal(
      describeInstallations("o/r", { slug: "kit-reviewer", id: 7 }, [
        { account: { login: "other" }, repository_selection: "selected" },
      ]),
      'App "kit-reviewer" (id 7) is installed on: other (selected repositories). Add o/r to the installation on its owner.',
    );
    assert.match(describeInstallations("o/r", null, []), /^The App has no installations/);
  });

  it("refuses to run without the App ID and a PEM key, before any network call", async () => {
    const { installationToken } = await load();
    await assert.rejects(
      installationToken({ GITHUB_REPOSITORY: "o/r", REVIEWER_APP_ID: "1" }),
      /are required/,
    );
  });
});

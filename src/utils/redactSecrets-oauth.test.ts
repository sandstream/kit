/**
 * kit-research t3code-mcp-sign-in-vs-kit: an OAuth sign-in on a remote machine ends with a pasted
 * `http://localhost:<port>/callback?code=…&state=…`. The authorization code and the PKCE verifier
 * were not redacted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "./redactSecrets.js";

describe("redactSecrets: OAuth callback URLs", () => {
  it("redacts the code when state follows it", () => {
    const out = redactSecrets(
      "http://localhost:33418/callback?code=4%2F0AfJohXkQ9bZ3c_longauthcode&state=af0ifjsldkj",
    );
    assert.equal(out, "http://localhost:33418/callback?code=[REDACTED]&state=af0ifjsldkj");
  });

  it("redacts the code when state comes first", () => {
    const out = redactSecrets(
      "http://127.0.0.1:8976/cb?state=af0ifjsldkj&code=SplxlOBeZQQYbYS6WxSbIA",
    );
    assert.equal(out, "http://127.0.0.1:8976/cb?state=af0ifjsldkj&code=[REDACTED]");
  });

  it("leaves a code= that is not an OAuth callback alone", () => {
    for (const s of [
      "https://x.example/err?code=ERR_NOT_FOUND_12345",
      "https://x.example/geo?code=SE-stockholm-0001&lang=sv",
    ]) {
      assert.equal(redactSecrets(s), s);
    }
  });

  it("redacts a PKCE code_verifier", () => {
    const out = redactSecrets(
      "grant_type=authorization_code&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    assert.match(out, /code_verifier=\[REDACTED\]/);
  });

  it("keeps the authorization URL's public parameters", () => {
    const url =
      "https://mcp.sentry.dev/oauth/authorize?client_id=x&state=af0ifjsldkj&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    assert.equal(redactSecrets(url), url);
  });
});

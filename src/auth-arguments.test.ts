import assert from "node:assert/strict";
import { it } from "node:test";
import { generateTotp } from "./elevation.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const invalid = [
  ["elevate", "--scope"],
  ["elevate", "--scope="],
  ["elevate", "--scope", "--ttl-minutes", "1"],
  ["elevate", "--scope", "--env", "prod", "all"],
  ["elevate", "--ttl-minutes", "--env", "prod", "1"],
  ["elevate", "--scope", "rotate", "--scope", "all"],
  ["elevate", "--ttl-minutes"],
  ["elevate", "--ttl-minutes=0"],
  ["elevate", "--ttl-minutes=abc"],
  ["elevate", "--ttl-minutes=1junk"],
  ["elevate", "--ttl-minutes=1.5"],
  ["elevate", "--ttl-minutes=241"],
  ["elevate", "--json"],
  ["elevate", "--list-scopes", "--scope=all"],
  ["setup-totp", "--issuer", "--account"],
  ["setup-totp", "--issuer", "--env", "prod", "kit"],
  ["setup-totp", "--account="],
  ["setup-totp", "--overwrite=false"],
  ["status", "extra"],
  ["status", "--", "extra"],
  ["status", "-x"],
  ["status", "--overwrite"],
  ["revoke", "--scope=all"],
];

for (const args of invalid) {
  it(`refuses invalid auth input before policy effects: ${args.join(" ")}`, (t) => {
    const fixture = createCliContractFixture('[policy]\ndefault_mode = "read-only"\n');
    t.after(() => fixture.cleanup());
    const before = fixture.snapshot();
    const result = fixture.run(["auth", ...args]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /usage: kit auth/);
    assert.deepEqual(fixture.snapshot(), before);
  });
}

it("auth status JSON is structured and leaves a fresh home unchanged", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run(["auth", "status", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { active: false, state: null });
  assert.deepEqual(fixture.snapshot(), before);
});

it("a valid piped authenticator code cannot replace a real terminal", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  delete fixture.env.CI;
  delete fixture.env.KIT_NON_INTERACTIVE;
  fixture.env.KIT_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
  const before = fixture.snapshot();
  const code = generateTotp(fixture.env.KIT_TOTP_SECRET);
  const result = fixture.run(["auth", "elevate", "--scope=rotate"], `${code}\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /requires an interactive TTY/);
  assert.deepEqual(fixture.snapshot(), before);
});

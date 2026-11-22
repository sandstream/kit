/**
 * kit-research rivanorth-oko-dark-web-monitoring-vs-kit: kit looked only inside the project. This
 * row lists the credential files in the home directory that an infostealer collects, with their
 * age, and never reads a value out.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkPlaintextCredentials,
  findPlaintextCredentials,
  isUnencryptedPrivateKey,
  judgePlaintextCredentials,
} from "./check-plaintext-credentials.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const DAY = 86_400_000;
const SECRET = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYzz";

function home(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-plain-cred-"));
  t.after(() => rmTemp(dir));
  const put = (rel: string, body: string, daysOld = 1, mode = 0o600) => {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    chmodSync(p, mode);
    const at = new Date(NOW - daysOld * DAY);
    utimesSync(p, at, at);
  };
  return { dir, put };
}

/** An OpenSSH private key header with the given cipher name. */
function opensshKey(cipher: string): string {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(cipher.length);
  const head = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), len, Buffer.from(cipher)]);
  const body = Buffer.concat([head, Buffer.alloc(64, 7)]).toString("base64");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

describe("findPlaintextCredentials", () => {
  it("finds credential files by marker and ignores configs without one", (t) => {
    const { dir, put } = home(t);
    put(
      ".aws/credentials",
      `[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = ${SECRET}\n`,
    );
    put(".npmrc", "registry=https://registry.npmjs.org/\n");
    put(".docker/config.json", '{"credsStore": "desktop"}');
    put(".config/gh/hosts.yml", `github.com:\n    oauth_token: gho_${"a".repeat(36)}\n`);
    const found = findPlaintextCredentials(dir, NOW).map((c) => c.shown);
    assert.deepEqual(found, ["~/.aws/credentials", "~/.config/gh/hosts.yml"]);
  });

  it("counts an SSH key without a passphrase and not one with", (t) => {
    const { dir, put } = home(t);
    put(".ssh/id_ed25519", opensshKey("none"));
    put(".ssh/id_rsa", opensshKey("aes256-ctr"));
    put(".ssh/id_ed25519.pub", "ssh-ed25519 AAAA\n");
    assert.deepEqual(
      findPlaintextCredentials(dir, NOW).map((c) => c.shown),
      ["~/.ssh/id_ed25519"],
    );
  });

  it("records the age, and on POSIX whether other accounts can read the file", (t) => {
    const { dir, put } = home(t);
    put(".netrc", "machine x.example login me password hunter2hunter2\n", 120, 0o644);
    const [c] = findPlaintextCredentials(dir, NOW, "linux");
    assert.equal(c?.ageDays, 120);
    if (process.platform !== "win32") assert.equal(c?.othersCanRead, true);
    assert.equal(findPlaintextCredentials(dir, NOW, "win32")[0]?.othersCanRead, false);
  });
});

describe("isUnencryptedPrivateKey", () => {
  it("reads the cipher name of an OpenSSH key and the header of a PEM key", () => {
    assert.equal(isUnencryptedPrivateKey(opensshKey("none")), true);
    assert.equal(isUnencryptedPrivateKey(opensshKey("aes256-ctr")), false);
    assert.equal(isUnencryptedPrivateKey("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n"), true);
    assert.equal(
      isUnencryptedPrivateKey("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n"),
      false,
    );
    assert.equal(isUnencryptedPrivateKey("ssh-ed25519 AAAA"), false);
  });
});

describe("judgePlaintextCredentials", () => {
  const cred = (over: Partial<Parameters<typeof judgePlaintextCredentials>[0][number]> = {}) => ({
    shown: "~/.npmrc",
    what: "npm token",
    ageDays: 3,
    othersCanRead: false,
    ...over,
  });

  it("passes with none, and says how many locations it checked", () => {
    const [r] = judgePlaintextCredentials([]);
    assert.equal(r?.status, "pass");
    assert.match(r?.detail ?? "", /none found \(\d+ known locations checked/);
  });

  it("passes but lists fresh, private files", () => {
    const [r] = judgePlaintextCredentials([cred()]);
    assert.equal(r?.status, "pass");
    assert.match(r?.detail ?? "", /~\/\.npmrc \(npm token, written 3 d ago\)/);
  });

  it("warns on a stale file and on one other accounts can read", () => {
    const [stale] = judgePlaintextCredentials([cred({ ageDays: 200 })]);
    assert.equal(stale?.status, "warn");
    assert.match(stale?.suggestion ?? "", /not rewritten in 90 days/);
    const [open] = judgePlaintextCredentials([cred({ othersCanRead: true })]);
    assert.equal(open?.status, "warn");
    assert.match(open?.suggestion ?? "", /chmod 600/);
  });
});

describe("checkPlaintextCredentials", () => {
  it("never prints a value", (t) => {
    const { dir, put } = home(t);
    put(".aws/credentials", `[default]\naws_secret_access_key = ${SECRET}\n`, 400);
    const out = JSON.stringify(checkPlaintextCredentials(dir, NOW));
    assert.match(out, /~\/\.aws\/credentials/);
    assert.equal(out.includes(SECRET), false);
    assert.equal(out.includes(dir), false, "the home path itself is not printed");
  });
});

describe("kit check's agent-config rows include it", () => {
  it("reports a credential file in the given home", async (t) => {
    const { dir, put } = home(t);
    put(".npmrc", `//registry.npmjs.org/:_authToken=npm_${"a".repeat(36)}\n`);
    const { checkAgentConfig } = await import("./check-agent-config.js");
    const rows = await checkAgentConfig(join(dir, "project-that-does-not-exist"), dir, {});
    const row = rows.find((r) => r.name === "plaintext credentials in the home directory");
    assert.match(row?.detail ?? "", /~\/\.npmrc \(npm token/);
  });
});

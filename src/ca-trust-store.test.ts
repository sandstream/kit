import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate } from "./install-gate.js";
import { caTrustChange, caTrustReason, caTrustRefusal } from "./ca-trust-store.js";

// kit-research artex-cc-vs-kit: ARTEX-CC's `init` prints the first three to trust its MITM proxy
// CA system-wide, and gate-bash passed each with exit 0.
const CHANGES: Array<[string, string]> = [
  [
    "sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.pem",
    "security add-trusted-cert",
  ],
  [
    "sudo cp ca.crt /usr/local/share/ca-certificates/artex.crt && sudo update-ca-certificates",
    "cp into /usr/local/share/ca-certificates/artex.crt",
  ],
  ["certutil -addstore Root ca.crt", "certutil -addstore Root"],
  ["certutil -addstore -f Root ca.crt", "certutil -addstore Root"],
  ["certutil.exe -f -addstore root ca.crt", "certutil -addstore Root"],
  ["certutil -user -addstore AuthRoot ca.crt", "certutil -addstore AuthRoot"],
  ["sudo update-ca-certificates", "update-ca-certificates"],
  ["update-ca-certificates --fresh", "update-ca-certificates"],
  ["sudo update-ca-trust extract", "update-ca-trust"],
  ["trust anchor ca.pem", "trust anchor"],
  ["sudo trust anchor --store ca.pem", "trust anchor"],
  [
    'Import-Certificate -FilePath ca.cer -CertStoreLocation "Cert:\\LocalMachine\\Root"',
    "Import-Certificate -CertStoreLocation Cert:\\LocalMachine\\Root",
  ],
  [
    "Import-PfxCertificate -FilePath ca.pfx -CertStoreLocation Cert:/CurrentUser/Root",
    "Import-PfxCertificate -CertStoreLocation Cert:/CurrentUser/Root",
  ],
  ["sudo cp ca.pem /etc/pki/ca-trust/source/anchors/", "cp into /etc/pki/ca-trust/source/anchors/"],
  [
    "sudo install -m 644 ca.crt /usr/local/share/ca-certificates/",
    "install into /usr/local/share/ca-certificates/",
  ],
  [
    "cat ca.pem | sudo tee /etc/pki/ca-trust/source/anchors/x.pem",
    "tee into /etc/pki/ca-trust/source/anchors/x.pem",
  ],
  [
    "cat ca.pem > /usr/local/share/ca-certificates/x.crt",
    "a redirect into /usr/local/share/ca-certificates/x.crt",
  ],
];

// The carriers the gate already reads.
const CARRIED = [
  "sh -c 'update-ca-certificates'",
  'bash -lc "sudo update-ca-trust"',
  "env DEBIAN_FRONTEND=noninteractive update-ca-certificates",
  "echo $(update-ca-certificates)",
  'cmd /c "certutil -addstore Root ca.crt"',
  'powershell -Command "Import-Certificate -FilePath ca.cer -CertStoreLocation Cert:\\LocalMachine\\Root"',
  `pwsh -EncodedCommand ${Buffer.from("certutil -addstore Root ca.crt", "utf16le").toString("base64")}`,
  "echo /usr/local/share/ca-certificates | xargs update-ca-certificates",
];

describe("CA trust-store change: the classifier", () => {
  for (const [command, named] of CHANGES) {
    it(`names it: ${command}`, () => {
      assert.equal(caTrustChange(command), named);
    });
  }

  for (const command of CARRIED) {
    it(`reads through the carrier: ${command}`, () => {
      assert.ok(caTrustChange(command), command);
    });
  }

  for (const command of [
    "update-ca-certificates --help",
    "trust list",
    "security find-certificate -a",
    "security verify-cert -c ca.pem",
    "certutil -dump ca.crt",
    "certutil -addstore My cert.pfx",
    "certutil -verifystore Root",
    "Import-Certificate -FilePath x.cer -CertStoreLocation Cert:\\CurrentUser\\My",
    "cp /usr/local/share/ca-certificates/x.crt /tmp/",
    "ls /etc/pki/ca-trust/source/anchors",
    "cat /usr/local/share/ca-certificates/x.crt",
    "export NODE_EXTRA_CA_CERTS=/path/ca.pem",
    "NODE_EXTRA_CA_CERTS=ca.pem npm test",
    'git commit -m "document update-ca-certificates"',
    "echo update-ca-certificates",
  ]) {
    it(`leaves it alone: ${command}`, () => {
      assert.equal(caTrustRefusal({ command, expansions: [] }), null);
    });
  }

  it("names the change and who runs it", () => {
    const reason = caTrustReason(caTrustChange("certutil -addstore Root ca.crt")!);
    assert.match(reason, /trusted root certificates \(certutil -addstore Root\)/);
    assert.match(reason, /Ask the person to run it themselves/);
  });
});

describe("CA trust-store change: gate-bash", () => {
  for (const command of [
    "sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.pem",
    "sudo cp ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates",
    "certutil -addstore Root ca.crt",
  ]) {
    it(`refuses before any registry request: ${command}`, async () => {
      const verdict = await decideBashGate(command);
      assert.equal(verdict.block, true);
      assert.match(verdict.reason, /changes the machine's trusted root certificates/);
      assert.deepEqual(verdict.checked, []);
    });
  }

  it("allows reading the store, and a per-process CA variable", async () => {
    assert.equal((await decideBashGate("trust list")).block, false);
    assert.equal((await decideBashGate("NODE_EXTRA_CA_CERTS=ca.pem node app.js")).block, false);
  });

  it("does not read a quoted here-document body as a command", async () => {
    const verdict = await decideBashGate("cat <<'EOF'\nsudo update-ca-certificates\nEOF");
    assert.equal(verdict.block, false);
  });
});

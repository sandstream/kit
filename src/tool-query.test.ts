import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brewPackageFor, latestQueryFor } from "./tool-query.js";

function brewPrefix(t: { after: (fn: () => void) => void }): string {
  const prefix = mkdtempSync(join(tmpdir(), "kit-brew-"));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  mkdirSync(join(prefix, "bin"));
  return prefix;
}

function keg(prefix: string, name: string, version: string, bin: string, tap?: string): string {
  const dir = join(prefix, "Cellar", name, version);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", bin), "");
  if (tap !== undefined)
    writeFileSync(join(dir, "INSTALL_RECEIPT.json"), JSON.stringify({ source: { tap } }));
  const link = join(prefix, "bin", bin);
  symlinkSync(join(dir, "bin", bin), link);
  return link;
}

describe("brewPackageFor", () => {
  it("names the keg that owns the binary, not the binary", (t) => {
    const prefix = brewPrefix(t);
    const psql = keg(prefix, "postgresql@16", "16.14", "psql", "homebrew/core");
    assert.equal(brewPackageFor(psql), "postgresql@16");
  });

  it("qualifies a tapped formula with its tap, which brew needs to find it", (t) => {
    const prefix = brewPrefix(t);
    const stripe = keg(prefix, "stripe", "1.41.1", "stripe", "stripe/stripe-cli");
    assert.equal(brewPackageFor(stripe), "stripe/stripe-cli/stripe");
  });

  it("keeps the plain name when the receipt is missing", (t) => {
    const prefix = brewPrefix(t);
    assert.equal(brewPackageFor(keg(prefix, "gh", "2.96.0", "gh")), "gh");
  });

  it("returns null outside a Cellar (a cask or a hand-made link)", (t) => {
    const prefix = brewPrefix(t);
    const share = join(prefix, "share", "google-cloud-sdk", "bin");
    mkdirSync(share, { recursive: true });
    writeFileSync(join(share, "gcloud"), "");
    symlinkSync(join(share, "gcloud"), join(prefix, "bin", "gcloud"));
    assert.equal(brewPackageFor(join(prefix, "bin", "gcloud")), null);
  });
});

describe("latestQueryFor", () => {
  it("asks mise about the declared backend reference, not the bare binary", () => {
    assert.deepEqual(latestQueryFor("aqua:boyter/scc", "mise", "/x/scc"), {
      name: "aqua:boyter/scc",
    });
    assert.deepEqual(latestQueryFor("node", "mise", "/x/node"), { name: "node" });
  });

  it("asks brew about the owning package", (t) => {
    const prefix = brewPrefix(t);
    const psql = keg(prefix, "postgresql@16", "16.14", "psql", "homebrew/core");
    assert.deepEqual(latestQueryFor("psql", "brew", psql), { name: "postgresql@16" });
  });

  it("says why it cannot ask brew instead of reporting a lookup that never ran", () => {
    const query = latestQueryFor("gcloud", "brew", "/nowhere/gcloud");
    assert.ok("unsupported" in query);
    assert.match(query.unsupported, /Cellar/);
  });

  it("asks other installers about the package, without the backend prefix", () => {
    assert.deepEqual(latestQueryFor("npm:@socketsecurity/cli", "npm-global", "/x/socket"), {
      name: "@socketsecurity/cli",
    });
    assert.deepEqual(latestQueryFor("pipx:lizard", "pipx", "/x/lizard"), { name: "lizard" });
    assert.deepEqual(latestQueryFor("vercel", "npm-global", "/x/vercel"), { name: "vercel" });
  });
});

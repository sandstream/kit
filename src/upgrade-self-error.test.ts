import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNpmPermissionError, npmPermissionRemediation } from "./cli.js";

describe("isNpmPermissionError — npm -g EACCES detection", () => {
  it("detects a classic EACCES global-prefix failure", () => {
    const stderr =
      "npm ERR! code EACCES\n" +
      "npm ERR! syscall mkdir\n" +
      "npm ERR! path /usr/local/lib/node_modules/sandstream-kit\n" +
      "npm ERR! errno -13\n" +
      "npm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/sandstream-kit'";
    assert.equal(isNpmPermissionError(stderr), true);
  });

  it("detects EPERM / operation not permitted", () => {
    assert.equal(isNpmPermissionError("npm ERR! Error: EPERM: operation not permitted"), true);
    assert.equal(isNpmPermissionError("permission denied"), true);
  });

  it("does NOT misfire on an unrelated network failure", () => {
    const stderr =
      "npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org failed";
    assert.equal(isNpmPermissionError(stderr), false);
  });

  it("does NOT misfire on a generic version-conflict failure", () => {
    assert.equal(isNpmPermissionError("npm ERR! ETARGET No matching version found"), false);
  });
});

describe("npmPermissionRemediation — actionable, sudo-free guidance", () => {
  const lines = npmPermissionRemediation();
  const joined = lines.join("\n");

  it("recommends a user-owned prefix, not sudo", () => {
    assert.match(joined, /npm config set prefix ~\/\.npm-global/);
    assert.match(joined, /\.npm-global\/bin/);
    assert.ok(!/\bsudo npm\b/.test(joined), "must not tell the user to sudo npm");
  });

  it("tells the user to re-run the upgrade", () => {
    assert.match(joined, /kit upgrade --self/);
  });
});

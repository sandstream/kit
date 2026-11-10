import assert from "node:assert/strict";
import { it } from "node:test";
import { extractHostsFromArgs } from "./broker/extract.js";

it("inspects exact argv without reinterpreting spaces or shell operators", () => {
  assert.deepEqual(extractHostsFromArgs(["node", "-e", "console.log('curl outside.invalid')"]), []);
  assert.deepEqual(extractHostsFromArgs(["echo", "curl", "outside.invalid"]), []);
  assert.deepEqual(extractHostsFromArgs(["curl", "a.invalid;echo", "b.invalid"]), ["b.invalid"]);
  assert.deepEqual(extractHostsFromArgs(["curl", "a.invalid", "&&", "echo", "b.invalid"]), [
    "a.invalid",
    "b.invalid",
  ]);
});

it("extracts fetch targets from executable paths and skips option values", () => {
  assert.deepEqual(
    extractHostsFromArgs(["/usr/bin/curl", "-o", "out.html", "a.invalid", "--header", "b.invalid"]),
    ["a.invalid"],
  );
  assert.deepEqual(extractHostsFromArgs(["C:\\Windows\\System32\\curl.exe", "A.INVALID/path"]), [
    "a.invalid",
  ]);
  assert.deepEqual(
    extractHostsFromArgs(["wget", "-P", "out.dir", "b.invalid", "https://a.invalid", "b.invalid"]),
    ["a.invalid", "b.invalid"],
  );
});

it("distinguishes curl remote-name from wget output-file for -O", () => {
  assert.deepEqual(extractHostsFromArgs(["curl", "-O", "outside.invalid"]), ["outside.invalid"]);
  assert.deepEqual(extractHostsFromArgs(["wget", "-O", "output.html", "outside.invalid"]), [
    "outside.invalid",
  ]);
});

it("parses complete URL arguments including IPv6 and authority delimiters", () => {
  assert.deepEqual(extractHostsFromArgs(["curl", "https://[2001:db8::1]/"]), ["[2001:db8::1]"]);
  assert.deepEqual(extractHostsFromArgs(["curl", "https://allowed.invalid;@outside.invalid/"]), [
    "outside.invalid",
  ]);
  assert.deepEqual(
    extractHostsFromArgs(["curl", "--url=https://allowed.invalid;@outside.invalid/"]),
    ["outside.invalid"],
  );
});

it("does not consume wget boolean flags as value options", () => {
  for (const flag of ["-c", "-d", "-m", "-b", "-E", "-H", "-K"]) {
    assert.deepEqual(
      extractHostsFromArgs(["wget", flag, "outside.invalid"]),
      ["outside.invalid"],
      flag,
    );
  }
});

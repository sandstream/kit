/**
 * Which kit the machine-wide wrapper points at.
 *
 * `~/.kit/bin/kit` is what every kit hook in every repo execs, and it used to be written with
 * whatever entrypoint happened to be running. So one `kit hooks add` from a development checkout
 * aimed the whole machine's enforcement floor at `…/kit-public/dist/cli.js` — a path
 * `npm run build` deletes on its first step (`clean-dist.mjs`). Measured (#509): a session in an
 * unrelated repo failed with
 *
 *     PreToolUse:Bash hook error … kit CLI entrypoint missing: …/kit-public/dist/cli.js
 *
 * and kept going UNGATED, because a hook that cannot start is reported non-blocking.
 *
 * Three properties are pinned here: an installed kit wins over a checkout; an explicit
 * `KIT_WRAPPER_ALLOW_DEV` still wins over that (asking for a dev pin must not be silently
 * overridden); and a checkout with no install to fall back on is written but LOUD, because
 * refusing outright would leave the hooks with no wrapper at all — worse than a fragile one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chooseWrapperEntry, pathInWorkingTree, defaultGlobalBins } from "./kit-wrapper.js";
import { describeWrapper, judgeWrapper } from "./hook-floor.js";

const CHECKOUT = "/work/kit-public/dist/cli.js";
const INSTALLED = "/home/dev/.npm-global/bin/kit";
const inTree = (p: string): boolean => p.startsWith("/work/");
const installedExists = (p: string): boolean => p === INSTALLED;

describe("chooseWrapperEntry", () => {
  it("prefers an installed kit over the checkout that is doing the writing", () => {
    const r = chooseWrapperEntry({
      running: CHECKOUT,
      globalBins: ["/home/dev/.npm-global/bin"],
      exists: installedExists,
      inWorkingTree: inTree,
    });
    assert.deepEqual(r, { path: INSTALLED, source: "installed" });
  });

  it("honours an explicit dev pin instead of quietly overriding the request", () => {
    const r = chooseWrapperEntry({
      running: CHECKOUT,
      globalBins: ["/home/dev/.npm-global/bin"],
      exists: installedExists,
      inWorkingTree: inTree,
      allowDev: true,
    });
    assert.equal(r?.path, CHECKOUT);
    assert.equal(r?.source, "running");
    assert.match(r?.warning ?? "", /by request/);
    assert.match(r?.warning ?? "", /disarm every kit hook/);
  });

  it("falls back to the checkout when nothing is installed — but says what that means", () => {
    const r = chooseWrapperEntry({
      running: CHECKOUT,
      globalBins: ["/nowhere/bin"],
      exists: () => false,
      inWorkingTree: inTree,
    });
    assert.equal(r?.path, CHECKOUT);
    assert.match(r?.warning ?? "", /no installed kit found/);
    assert.match(r?.warning ?? "", /npm i -g sandstream-kit/);
  });

  it("keeps a running entrypoint that is already an install, without probing", () => {
    const r = chooseWrapperEntry({
      running: "/usr/local/lib/node_modules/sandstream-kit/dist/cli.js",
      globalBins: ["/nowhere/bin"],
      exists: () => false,
      inWorkingTree: inTree,
    });
    assert.equal(r?.source, "running");
    assert.equal(r?.warning, undefined);
  });

  it("uses the install when there is no running entrypoint at all", () => {
    const r = chooseWrapperEntry({
      globalBins: ["/home/dev/.npm-global/bin"],
      exists: installedExists,
      inWorkingTree: inTree,
    });
    assert.deepEqual(r, { path: INSTALLED, source: "installed" });
  });

  it("returns null rather than inventing a path when there is nothing to point at", () => {
    assert.equal(
      chooseWrapperEntry({ globalBins: ["/nowhere"], exists: () => false, inWorkingTree: inTree }),
      null,
    );
  });

  it("probes the usual global bin dirs, most specific first", () => {
    const bins = defaultGlobalBins("/home/dev");
    assert.equal(bins[0], join("/home/dev", ".npm-global", "bin"));
    assert.ok(bins.includes("/usr/local/bin"));
    assert.ok(bins.includes("/opt/homebrew/bin"));
  });
});

describe("pathInWorkingTree", () => {
  it("finds a .git above the path", () => {
    const exists = (p: string): boolean => p === "/work/kit-public/.git";
    assert.equal(pathInWorkingTree("/work/kit-public/dist/cli.js", exists), true);
  });

  it("says no for an install path with no .git above it", () => {
    assert.equal(
      pathInWorkingTree("/usr/local/lib/node_modules/sandstream-kit/dist/cli.js", () => false),
      false,
    );
  });
});

describe("describeWrapper / judgeWrapper", () => {
  const wrapperBody = (node: string, cli: string): string =>
    ["#!/bin/sh", "# kit-managed wrapper (do not edit)", `exec "${node}" "${cli}" "$@"`, ""].join(
      "\n",
    );

  const withHome = (body?: string): string => {
    const home = mkdtempSync(join(tmpdir(), "kit-wrap-"));
    if (body !== undefined) {
      mkdirSync(join(home, ".kit", "bin"), { recursive: true });
      writeFileSync(join(home, ".kit", "bin", "kit"), body);
    }
    return home;
  };

  it("skips when there is no wrapper to judge", () => {
    const home = withHome();
    try {
      const v = judgeWrapper(describeWrapper(home));
      assert.equal(v.status, "skip");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not claim an unmanaged file at that path", () => {
    const home = withHome('#!/bin/sh\nexec /somewhere/else "$@"\n');
    try {
      const r = describeWrapper(home);
      assert.equal(r.managed, false);
      assert.equal(judgeWrapper(r).status, "skip");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("FAILS when the entrypoint is gone — every hook on the machine is dead", () => {
    const home = withHome(wrapperBody("/usr/bin/node", "/gone/dist/cli.js"));
    try {
      const r = describeWrapper(home);
      assert.equal(r.entry, "/gone/dist/cli.js");
      assert.equal(r.entryMissing, true);
      const v = judgeWrapper(r);
      assert.equal(v.status, "fail");
      assert.equal(v.severity, "high");
      assert.match(v.detail, /EVERY kit hook on this machine is dead/);
      assert.match(v.detail, /non-blocking, so sessions run ungated/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("warns when the entrypoint is inside a working tree — it works until the next build", () => {
    const home = withHome("");
    const tree = mkdtempSync(join(tmpdir(), "kit-wrap-tree-"));
    try {
      mkdirSync(join(tree, ".git"), { recursive: true });
      mkdirSync(join(tree, "dist"), { recursive: true });
      const cli = join(tree, "dist", "cli.js");
      writeFileSync(cli, "// build artifact");
      mkdirSync(join(home, ".kit", "bin"), { recursive: true });
      writeFileSync(join(home, ".kit", "bin", "kit"), wrapperBody("/usr/bin/node", cli));

      const r = describeWrapper(home);
      assert.equal(r.entryMissing, false);
      assert.equal(r.entryInWorkingTree, true);
      const v = judgeWrapper(r);
      assert.equal(v.status, "warn");
      assert.match(v.detail, /inside a git working tree/);
      assert.match(v.detail, /disarm every kit hook/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it("passes for an installed entrypoint, and names it", () => {
    const home = withHome("");
    const install = mkdtempSync(join(tmpdir(), "kit-wrap-install-"));
    try {
      const cli = join(install, "cli.js");
      writeFileSync(cli, "// installed");
      mkdirSync(join(home, ".kit", "bin"), { recursive: true });
      writeFileSync(join(home, ".kit", "bin", "kit"), wrapperBody("/usr/bin/node", cli));

      const v = judgeWrapper(describeWrapper(home));
      assert.equal(v.status, "pass");
      assert.match(v.detail, new RegExp(cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(install, { recursive: true, force: true });
    }
  });
});

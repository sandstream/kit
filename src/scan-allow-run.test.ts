import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
// Built from pieces so this file holds no secret-shaped string of its own.
const VALUE = ["A7mK9qR2", "vX4yZ8bP", "5nW3dC6f"].join("");
const SECRET_LINE = `const PASSWORD = "${VALUE}";\n`;
const REASON = "CI cache key, not a credential";

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
}

/**
 * A repo whose `.kit.toml` (made of `allow` tables, none when empty) is already committed, as a
 * reviewed exception list is, with one file staged on top. `commitAllow: false` leaves the list
 * out of the history, so it only exists in the working copy.
 */
function repo(file: string, content: string, allow: string[] = [], commitAllow = true): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-scan-allow-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", "README.md");
  if (allow.length > 0) {
    writeFileSync(join(dir, ".kit.toml"), allow.join("\n"));
    if (commitAllow) git(dir, "add", ".kit.toml");
  }
  git(dir, "commit", "-q", "-m", "baseline");
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  git(dir, "add", file);
  return dir;
}

function scan(dir: string) {
  const r = spawnSync(process.execPath, [CLI, "security", "scan-staged"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
}

const entry = (path: string, extra = `reason = "${REASON}"`) =>
  `[[scan.allow]]\npath = "${path}"\nmatch = "keyed-secret"\n${extra}\n`;

describe("kit security scan-staged with [[scan.allow]], what gets through", () => {
  it("blocks a secret-shaped line when there is no allowlist", () => {
    const dir = repo("ci.js", SECRET_LINE);
    try {
      assert.equal(scan(dir).status, 1);
    } finally {
      rmTemp(dir);
    }
  });

  it("lets a covered finding through and names the entry and its reason", () => {
    const dir = repo("ci.js", SECRET_LINE, [entry("ci.js")]);
    try {
      const r = scan(dir);
      assert.equal(r.status, 0, r.text);
      assert.match(r.text, /allowed by \[\[scan\.allow\]\]/);
      assert.match(r.text, /ci\.js/);
      assert.match(r.text, new RegExp(REASON));
    } finally {
      rmTemp(dir);
    }
  });

  it("still blocks the same finding in a file the entry does not name", () => {
    const dir = repo("other.js", SECRET_LINE, [entry("ci.js")]);
    try {
      assert.equal(scan(dir).status, 1);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("kit security scan-staged with [[scan.allow]], what is refused or reported", () => {
  it("blocks and names the fix when an entry has no reason", () => {
    const dir = repo("ci.js", SECRET_LINE, [entry("ci.js", "")]);
    try {
      const r = scan(dir);
      assert.equal(r.status, 1);
      assert.match(r.text, /entry 1/);
      assert.match(r.text, /why this match is harmless/);
    } finally {
      rmTemp(dir);
    }
  });

  it("blocks even a clean commit while the allowlist is broken", () => {
    const dir = repo("ci.js", "const x = 1;\n", [entry("ci.js", "")]);
    try {
      const r = scan(dir);
      assert.equal(r.status, 1, r.text);
      assert.match(r.text, /why this match is harmless/);
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses a directory entry instead of silencing the directory", () => {
    const dir = repo("src/ci.js", SECRET_LINE, [entry("src/")]);
    try {
      const r = scan(dir);
      assert.equal(r.status, 1);
      assert.match(r.text, /not a directory/);
    } finally {
      rmTemp(dir);
    }
  });

  it("reports an entry that matched nothing as stale, without blocking", () => {
    const dir = repo("ci.js", "const x = 1;\n", [entry("ci.js")]);
    try {
      const r = scan(dir);
      assert.equal(r.status, 0, r.text);
      assert.match(r.text, /stale/);
      assert.match(r.text, /matched nothing/);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("kit security scan-staged reads [[scan.allow]] from what is committed", () => {
  it("warns when .kit.toml is part of the commit that silences a finding", () => {
    const dir = repo("ci.js", SECRET_LINE, [entry("ci.js")], false);
    try {
      git(dir, "add", ".kit.toml");
      const r = scan(dir);
      assert.equal(r.status, 0, r.text);
      assert.match(r.text, /\.kit\.toml is part of this commit/);
    } finally {
      rmTemp(dir);
    }
  });

  it("ignores an entry that only exists in the working copy, and says so", () => {
    const dir = repo("ci.js", SECRET_LINE, [entry("ci.js")], false);
    try {
      const r = scan(dir);
      assert.equal(r.status, 1, r.text);
      assert.match(r.text, /not applied until/);
    } finally {
      rmTemp(dir);
    }
  });

  it("uses the committed list, not an unstaged edit of it", () => {
    const dir = repo("ci.js", SECRET_LINE, [entry("ci.js")]);
    try {
      writeFileSync(join(dir, ".kit.toml"), entry("ci.js") + entry("other.js"));
      assert.equal(scan(dir).status, 0);
      writeFileSync(join(dir, ".kit.toml"), "");
      assert.equal(scan(dir).status, 0, "an unstaged deletion does not drop the committed list");
    } finally {
      rmTemp(dir);
    }
  });
});

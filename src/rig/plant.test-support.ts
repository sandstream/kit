import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A repo with: base, a buggy line, its fix, then an unrelated later change (the pinned commit). */
export function historyRepo(): { dir: string; fix: string; pinned: string; twoFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "kit-rig-plant-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();
  const lines = (n: number, patch: Record<number, string> = {}): string =>
    Array.from({ length: n }, (_, i) => patch[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
  git("init", "-q");
  writeFileSync(join(dir, "auth.ts"), lines(20, { 10: "if (token) allow();" }));
  writeFileSync(join(dir, "other.ts"), lines(5));
  git("add", ".");
  git("commit", "-q", "-m", "buggy");
  writeFileSync(join(dir, "auth.ts"), lines(20, { 10: "if (token && verify(token)) allow();" }));
  git("commit", "-q", "-am", "fix: verify the token");
  const fix = git("rev-parse", "HEAD");
  writeFileSync(
    join(dir, "auth.ts"),
    "// header\n// header\n" + lines(20, { 10: "if (token && verify(token)) allow();" }),
  );
  git("commit", "-q", "-am", "later: add a header");
  const pinned = git("rev-parse", "HEAD");
  writeFileSync(
    join(dir, "auth.ts"),
    "// header\n// header\n" + lines(20, { 10: "if (token && check(token)) allow();" }),
  );
  writeFileSync(join(dir, "other.ts"), lines(5, { 2: "changed" }));
  git("commit", "-q", "-am", "two files");
  const twoFile = git("rev-parse", "HEAD");
  return { dir, fix, pinned, twoFile };
}

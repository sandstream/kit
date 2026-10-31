import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "../memory/db.js";
import type { ReadCommand } from "../review-receipt-io.js";
import { runFeed } from "./feed.js";

const gh: ReadCommand = (_cmd, args) => {
  const path = args.find((a) => a.startsWith("repos/")) ?? "";
  if (args.includes("nameWithOwner") || args.includes(".nameWithOwner")) return "o/r\n";
  if (path === "repos/o/r") return "main\n";
  if (path.startsWith("repos/o/r/actions/workflows?"))
    return JSON.stringify({ id: 7, name: "CI" }) + "\n";
  if (path.startsWith("repos/o/r/actions/workflows/7/runs"))
    return JSON.stringify([
      {
        conclusion: "failure",
        html_url: "https://x/run/1",
        head_sha: "abc1234",
        event: "push",
        created_at: new Date().toISOString(),
      },
    ]);
  if (path.startsWith("repos/o/r/dependabot/alerts")) throw new Error("HTTP 403");
  throw new Error(`unexpected ${args.join(" ")}`);
};

function run(argv: string[], db = openMemoryDb(":memory:")) {
  // The command closes its handle; keep this one open so the test can read the ledger afterwards.
  Object.defineProperty(db, "close", { value: () => undefined });
  const out: string[] = [];
  const err: string[] = [];
  const ok = runFeed(
    argv,
    { run: gh, open: () => db },
    (l) => out.push(l),
    (l) => err.push(l),
  );
  return { ok, out: out.join("\n"), err: err.join("\n"), db };
}

describe("kit feed github", () => {
  it("opens an item for a failed workflow and says which source it could not read", () => {
    const r = run(["feed", "github", "--repo", "o/r"]);
    assert.equal(r.ok, true);
    assert.match(r.out, /CI failed: CI on main/);
    assert.match(r.out, /token cannot read alerts/);
    assert.equal(
      r.db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE status='open'").get()?.n,
      1,
    );
  });

  it("reads the repository from the current directory when --repo is absent", () => {
    assert.match(run(["feed", "github"]).out, /o\/r/);
  });

  it("writes nothing with --dry-run", () => {
    const r = run(["feed", "github", "--repo", "o/r", "--dry-run"]);
    assert.match(r.out, /dry run/i);
    assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM pending_actions").get()?.n, 0);
  });

  it("prints a machine-readable summary with --json", () => {
    const parsed = JSON.parse(run(["feed", "github", "--repo", "o/r", "--json"]).out) as {
      repo: string;
      ci: { added: number } | null;
    };
    assert.equal(parsed.repo, "o/r");
    assert.equal(parsed.ci?.added, 1);
  });

  it("refuses an unknown source and a malformed repository", () => {
    assert.equal(run(["feed", "sentry"]).ok, false);
    const bad = run(["feed", "github", "--repo", "--paginate"]);
    assert.equal(bad.ok, false);
    assert.match(bad.err, /owner\/name/);
  });

  it("tells the user to log in and keeps a ledger item until the login works again", () => {
    const db = openMemoryDb(":memory:");
    Object.defineProperty(db, "close", { value: () => undefined });
    const deps = (run: ReadCommand) => ({ run, open: () => db });
    const bad: ReadCommand = () => {
      throw new Error("gh: Bad credentials (HTTP 401)");
    };
    const err: string[] = [];
    const ok = runFeed(
      ["feed", "github", "--repo", "o/r"],
      deps(bad),
      () => undefined,
      (l) => err.push(l),
    );
    assert.equal(ok, false);
    assert.match(err.join("\n"), /gh auth login/);
    const titles = () =>
      db
        .prepare("SELECT title FROM pending_actions WHERE status='open'")
        .all()
        .map((r) => r.title);
    assert.deepEqual(titles(), ["GitHub feed: not logged in"]);
    runFeed(
      ["feed", "github", "--repo", "o/r"],
      deps(gh),
      () => undefined,
      () => undefined,
    );
    assert.deepEqual(titles(), ["CI failed: CI on main"]);
  });
});

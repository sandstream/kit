import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "./memory/db.js";
import type { GithubFeed } from "./feed-github.js";
import type { VercelFeed } from "./feed-vercel.js";
import { syncFeedAuth, syncGithubFeed, syncVercelFeed } from "./feed-sync.js";

const failing = { dedupKey: "ci:CI:main", title: "CI failed: CI on main", detail: "run" };
const feed = (over: Partial<GithubFeed> = {}): GithubFeed => ({
  repo: "o/r",
  branch: "main",
  ci: [failing],
  dependabot: [],
  notes: [],
  ...over,
});
const open = (db: ReturnType<typeof openMemoryDb>) =>
  db.prepare("SELECT id, title, scope FROM pending_actions WHERE status='open'").all();

describe("syncGithubFeed", () => {
  it("opens an item for a failure, keeps it on a repeat run, and closes it when green", () => {
    const db = openMemoryDb(":memory:");
    assert.deepEqual(syncGithubFeed(db, feed()).ci, { added: 1, reopened: 0, closed: [] });
    assert.equal(syncGithubFeed(db, feed()).ci?.added, 0);
    assert.equal(open(db).length, 1);
    assert.equal(syncGithubFeed(db, feed({ ci: [] })).ci?.closed.length, 1);
    assert.equal(open(db).length, 0);
  });

  it("leaves open items alone when a source could not be read", () => {
    const db = openMemoryDb(":memory:");
    syncGithubFeed(db, feed());
    const result = syncGithubFeed(db, feed({ ci: null }));
    assert.equal(result.ci, null);
    assert.equal(open(db).length, 1);
  });

  it("has no scope, so a project list can show it", () => {
    const db = openMemoryDb(":memory:");
    syncGithubFeed(db, feed());
    assert.deepEqual(
      open(db).map((r) => r.scope),
      [null],
    );
  });

  it("keeps two repositories apart", () => {
    const db = openMemoryDb(":memory:");
    syncGithubFeed(db, feed({ repo: "o/a" }));
    syncGithubFeed(db, feed({ repo: "o/b" }));
    assert.equal(open(db).length, 2);
    syncGithubFeed(db, feed({ repo: "o/a", ci: [] }));
    assert.equal(open(db).length, 1);
  });

  it("tracks Dependabot alerts under their own source", () => {
    const db = openMemoryDb(":memory:");
    const alert = { dedupKey: "dep:GHSA-x:zod", title: "Dependabot low: zod" };
    syncGithubFeed(db, feed({ ci: [], dependabot: [alert] }));
    assert.equal(open(db).length, 1);
    syncGithubFeed(db, feed({ ci: [failing], dependabot: [] }));
    assert.deepEqual(
      open(db).map((r) => r.title),
      ["CI failed: CI on main"],
    );
  });
});

describe("syncVercelFeed", () => {
  const failed = {
    dedupKey: "vercel:shop:production",
    title: "Vercel deploy failed: shop (production)",
  };
  const vercel = (over: Partial<VercelFeed> = {}): VercelFeed => ({
    scope: "personal",
    production: [failed],
    notes: [],
    ...over,
  });

  it("opens an item for a failed deploy, keeps it on a repeat run, closes it when it is fixed", () => {
    const db = openMemoryDb(":memory:");
    assert.deepEqual(syncVercelFeed(db, vercel()), { added: 1, reopened: 0, closed: [] });
    assert.equal(syncVercelFeed(db, vercel())?.added, 0);
    assert.equal(syncVercelFeed(db, vercel({ production: [] }))?.closed.length, 1);
    assert.equal(open(db).length, 0);
  });

  it("leaves open items alone when Vercel could not be read", () => {
    const db = openMemoryDb(":memory:");
    syncVercelFeed(db, vercel());
    assert.equal(syncVercelFeed(db, vercel({ production: null })), null);
    assert.equal(open(db).length, 1);
  });

  it("keeps the personal scope and a team apart", () => {
    const db = openMemoryDb(":memory:");
    syncVercelFeed(db, vercel());
    syncVercelFeed(db, vercel({ scope: "team_abc" }));
    assert.equal(open(db).length, 2);
    syncVercelFeed(db, vercel({ production: [] }));
    assert.equal(open(db).length, 1);
  });
});

describe("syncFeedAuth", () => {
  it("tracks each service's login on its own", () => {
    const db = openMemoryDb(":memory:");
    syncFeedAuth(db, true, "github");
    syncFeedAuth(db, true, "vercel");
    assert.equal(open(db).length, 2);
    syncFeedAuth(db, false, "github");
    assert.deepEqual(
      open(db).map((r) => r.title),
      ["Vercel feed: not logged in"],
    );
  });
});

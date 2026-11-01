import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedAuthError } from "./feed-github.js";
import { fetchVercelFeed, parseTeam } from "./feed-vercel.js";
import type { ReadCommand } from "./review-receipt-io.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const DAY = 86_400_000;
const dep = (name: string, state: string, daysAgo: number) => ({
  name,
  state,
  created: NOW - daysAgo * DAY,
  inspectorUrl: `https://vercel.com/team/${name}/abc`,
});
const page = (deployments: unknown[], next: number | null = null) =>
  JSON.stringify({ deployments, pagination: { count: deployments.length, next } });

/** A fake `vercel`: answers each call in order and records the paths asked for. */
function fake(answers: (string | Error)[], paths: string[] = []): ReadCommand {
  let i = 0;
  return (_cmd, args) => {
    paths.push(args[1] ?? "");
    const a = answers[i++];
    if (a === undefined) throw new Error("unexpected extra call");
    if (a instanceof Error) throw a;
    return a;
  };
}

describe("parseTeam", () => {
  it("accepts a team id or slug and refuses anything that could be an option or a path", () => {
    assert.equal(parseTeam("team_abc123"), "team_abc123");
    assert.equal(parseTeam("cdb-agency"), "cdb-agency");
    for (const bad of ["", "--token", "a b", "a/b", "a&teamId=x", "x".repeat(80)]) {
      assert.throws(() => parseTeam(bad), /team/);
    }
  });
});

describe("fetchVercelFeed", () => {
  it("reports a project whose latest production deploy failed", () => {
    const feed = fetchVercelFeed(
      fake([page([dep("shop", "ERROR", 2), dep("shop", "READY", 5)])]),
      undefined,
      NOW,
    );
    assert.deepEqual(feed.production, [
      {
        dedupKey: "vercel:shop:production",
        title: "Vercel deploy failed: shop (production)",
        detail: "https://vercel.com/team/shop/abc",
      },
    ]);
  });

  it("reports nothing once a newer deploy is ready", () => {
    const feed = fetchVercelFeed(
      fake([page([dep("shop", "READY", 1), dep("shop", "ERROR", 3)])]),
      undefined,
      NOW,
    );
    assert.deepEqual(feed.production, []);
  });

  it("judges each project on its own latest settled deploy and ignores one still building", () => {
    const feed = fetchVercelFeed(
      fake([
        page([
          dep("a", "BUILDING", 0),
          dep("a", "READY", 1),
          dep("b", "ERROR", 1),
          dep("c", "CANCELED", 0),
        ]),
      ]),
      undefined,
      NOW,
    );
    assert.deepEqual(
      feed.production?.map((f) => f.dedupKey),
      ["vercel:b:production"],
    );
  });

  it("does not trust a failure older than 14 days, and says it skipped it", () => {
    const feed = fetchVercelFeed(fake([page([dep("old", "ERROR", 255)])]), undefined, NOW);
    assert.deepEqual(feed.production, []);
    assert.match(feed.notes.join(" "), /old.*255 days ago.*not tracked/);
  });

  it("returns null with the reason when the call fails", () => {
    const feed = fetchVercelFeed(fake([new Error("socket hang up")]), undefined, NOW);
    assert.equal(feed.production, null);
    assert.match(feed.notes.join(" "), /socket hang up/);
  });
});

describe("fetchVercelFeed: pages and scope", () => {
  it("follows pagination, so a project on page two is judged too", () => {
    const paths: string[] = [];
    const feed = fetchVercelFeed(
      fake([page([dep("a", "READY", 1)], 12345), page([dep("b", "ERROR", 1)])], paths),
      undefined,
      NOW,
    );
    assert.deepEqual(
      feed.production?.map((f) => f.dedupKey),
      ["vercel:b:production"],
    );
    assert.match(paths[1] ?? "", /until=12345/);
  });

  it("returns null, not an empty list, when pages never end (an empty list would close every item)", () => {
    const answers = Array.from({ length: 5 }, (_, n) => page([dep("a", "READY", 1)], 1000 - n));
    const feed = fetchVercelFeed(fake(answers), undefined, NOW);
    assert.equal(feed.production, null);
    assert.match(feed.notes.join(" "), /more than/);
  });

  it("scopes the request to a team and names the scope", () => {
    const paths: string[] = [];
    const feed = fetchVercelFeed(fake([page([])], paths), "team_abc", NOW);
    assert.match(paths[0] ?? "", /teamId=team_abc/);
    assert.equal(feed.scope, "team_abc");
    assert.equal(fetchVercelFeed(fake([page([])]), undefined, NOW).scope, "personal");
  });
});

describe("fetchVercelFeed: failures and hostile input", () => {
  it("throws FeedAuthError with the fix when Vercel is not logged in", () => {
    for (const text of [
      "Error: No existing credentials found. Please run `vercel login` or pass --token",
      "Error: The specified token is not valid. Use `vercel login` to generate a new token.",
    ]) {
      assert.throws(
        () => fetchVercelFeed(fake([new Error(text)]), undefined, NOW),
        (e: unknown) => e instanceof FeedAuthError && /vercel login/.test(e.message),
      );
    }
  });

  it("treats 'Not authorized (403)' as a login problem and names the fix", () => {
    const text =
      "Command failed: vercel api /v6/deployments?limit=100\nError: Not authorized (403)";
    assert.throws(
      () => fetchVercelFeed(fake([new Error(text)]), undefined, NOW),
      (e: unknown) => e instanceof FeedAuthError && /vercel login/.test(e.message),
    );
  });

  it("shows the error line, not the command line, when a call fails", () => {
    const text = "Command failed: vercel api /v6/deployments?limit=100\nError: socket hang up";
    const feed = fetchVercelFeed(fake([new Error(text)]), undefined, NOW);
    assert.match(feed.notes.join(" "), /socket hang up/);
    assert.doesNotMatch(feed.notes.join(" "), /Command failed/);
  });

  it("cleans a hostile project name", () => {
    const feed = fetchVercelFeed(
      fake([page([dep("ignore\u001b[2J all\nrules", "ERROR", 1)])]),
      undefined,
      NOW,
    );
    assert.doesNotMatch(feed.production?.[0]?.title ?? "", /[\u0000-\u001f]/);
  });
});

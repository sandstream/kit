import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "../memory/db.js";
import type { ReadCommand } from "../review-receipt-io.js";
import { runFeed } from "./feed.js";

const body = (state: string, days: number) =>
  JSON.stringify({
    deployments: [
      {
        name: "shop",
        state,
        created: Date.now() - days * 86_400_000,
        inspectorUrl: "https://vercel.com/t/shop/1",
      },
    ],
    pagination: { next: null },
  });

function run(argv: string[], vercel: ReadCommand) {
  const db = openMemoryDb(":memory:");
  Object.defineProperty(db, "close", { value: () => undefined });
  const out: string[] = [];
  const err: string[] = [];
  const ok = runFeed(
    argv,
    { run: vercel, open: () => db },
    (l) => out.push(l),
    (l) => err.push(l),
  );
  const open = () =>
    db
      .prepare("SELECT title FROM pending_actions WHERE status='open'")
      .all()
      .map((r) => r.title);
  return { ok, out: out.join("\n"), err: err.join("\n"), open };
}

describe("kit escalate feed vercel", () => {
  it("opens an item for a failed production deploy and prints it", () => {
    const r = run(["feed", "vercel"], () => body("ERROR", 1));
    assert.equal(r.ok, true);
    assert.match(r.out, /Vercel deploy failed: shop/);
    assert.deepEqual(r.open(), ["Vercel deploy failed: shop (production)"]);
  });

  it("writes nothing with --dry-run", () => {
    const r = run(["feed", "vercel", "--dry-run"], () => body("ERROR", 1));
    assert.match(r.out, /dry run/i);
    assert.deepEqual(r.open(), []);
  });

  it("prints a machine-readable summary with --json", () => {
    const parsed = JSON.parse(run(["feed", "vercel", "--json"], () => body("READY", 1)).out) as {
      scope: string;
      production: { added: number } | null;
    };
    assert.equal(parsed.scope, "personal");
    assert.equal(parsed.production?.added, 0);
  });

  it("refuses a malformed team", () => {
    const r = run(["feed", "vercel", "--team", "--token"], () => body("READY", 1));
    assert.equal(r.ok, false);
    assert.match(r.err, /team/);
  });

  it("tells the user to log in and keeps an item for it", () => {
    const bad: ReadCommand = () => {
      throw new Error("Error: No existing credentials found. Please run `vercel login`");
    };
    const r = run(["feed", "vercel"], bad);
    assert.equal(r.ok, false);
    assert.match(r.err, /vercel login/);
    assert.deepEqual(r.open(), ["Vercel feed: not logged in"]);
  });
});

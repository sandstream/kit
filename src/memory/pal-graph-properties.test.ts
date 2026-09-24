import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import fc from "fast-check";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import { palAdd, palResolve, palShow } from "./pal.js";
import { withPalDevice } from "./pal-fixture.test-support.js";

const orders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
const edits = fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 4 });

/** Close and remove every generated store before fast-check tries another case. */
function withStores(run: (open: (name: string) => { db: DatabaseSync; path: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kit-pal-graph-properties-"));
  const handles: DatabaseSync[] = [];
  try {
    withPalDevice("graph-property-device", () =>
      run((name) => {
        const path = join(dir, name + ".db");
        const db = openMemoryDb(path);
        handles.push(db);
        return { db, path };
      }),
    );
  } finally {
    try {
      for (const db of handles.reverse()) db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function edit(db: DatabaseSync, id: string, title: string, detail: string) {
  const view = palShow(db, id)!;
  const result = palResolve(db, id, {
    expectedFrontier: view.frontier,
    choice: { state: { ...view.heads[0].state, title, detail } },
  });
  assert.equal(result.status, "applied");
  return result.view!;
}

it("preserves offline chains and every head across all import orders, retries and forwarding", () => {
  fc.assert(
    fc.property(fc.tuple(edits, edits, edits), (branches) => {
      withStores((open) => {
        const origin = open("origin");
        const id = palAdd(origin.db, { title: "Origin" });
        const replicas = branches.map((titles, branch) => {
          const replica = open("branch-" + branch);
          mergeDb(replica.db, origin.path);
          withPalDevice("graph-branch-" + branch, () => {
            titles.forEach((title, index) => edit(replica.db, id, title, `${branch}:${index}`));
          });
          return { ...replica, view: palShow(replica.db, id, { history: true })! };
        });
        const expected = [
          ...new Map(
            replicas.flatMap(({ view }) =>
              view.history!.map((revision) => [revision.id, revision] as const),
            ),
          ).values(),
        ].sort((a, b) => (a.id < b.id ? -1 : 1));
        const heads = replicas
          .flatMap(({ view }) => view.heads)
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        let frontier: string | undefined;
        for (const order of orders) {
          const receiver = open("receiver-" + order.join(""));
          for (const index of order) mergeDb(receiver.db, replicas[index].path);
          const view = palShow(receiver.db, id, { history: true })!;
          assert.deepEqual(view.history, expected, "union retains original immutable events");
          assert.deepEqual(view.heads, heads, "each offline branch remains a head");
          assert.equal(view.conflict, true);
          if (frontier !== undefined) assert.equal(view.frontier, frontier);
          frontier = view.frontier;
          for (const index of [...order].reverse()) mergeDb(receiver.db, replicas[index].path);
          assert.deepEqual(palShow(receiver.db, id, { history: true }), view);
          const forwarded = open("forwarded-" + order.join(""));
          mergeDb(forwarded.db, receiver.path);
          assert.deepEqual(palShow(forwarded.db, id, { history: true }), view);
        }
      });
    }),
    { numRuns: 20, seed: 20260913 },
  );
});

it("diamond resolution cannot hide a delayed branch and converges after explicit resolution", () => {
  fc.assert(
    fc.property(fc.tuple(edits, edits, edits), (branches) => {
      withStores((open) => {
        const origin = open("origin");
        const id = palAdd(origin.db, { title: "Origin" });
        const replicas = branches.map((titles, branch) => {
          const replica = open("branch-" + branch);
          mergeDb(replica.db, origin.path);
          titles.forEach((title, index) => edit(replica.db, id, title, `${branch}:${index}`));
          return replica;
        });
        const joined = open("joined");
        mergeDb(joined.db, replicas[0].path);
        mergeDb(joined.db, replicas[1].path);
        const competing = palShow(joined.db, id)!;
        const resolved = edit(joined.db, id, "Resolution", "first two branches");
        assert.deepEqual(resolved.heads[0].parents, competing.heads.map(({ id }) => id).sort());
        assert.equal(resolved.conflict, false);
        mergeDb(joined.db, replicas[2].path);
        const delayed = palShow(joined.db, id)!;
        const third = palShow(replicas[2].db, id)!;
        assert.deepEqual(
          delayed.heads.map(({ id }) => id).sort(),
          [resolved.heads[0].id, third.heads[0].id].sort(),
        );
        assert.equal(delayed.conflict, true);
        const final = edit(joined.db, id, "Final resolution", "all three branches");
        assert.deepEqual(final.heads[0].parents, delayed.heads.map(({ id }) => id).sort());
        const expected = palShow(joined.db, id, { history: true });
        for (const replica of replicas) {
          mergeDb(replica.db, joined.path);
          assert.deepEqual(palShow(replica.db, id, { history: true }), expected);
          mergeDb(joined.db, replica.path);
          assert.deepEqual(palShow(joined.db, id, { history: true }), expected);
        }
      });
    }),
    { numRuns: 20, seed: 20260914 },
  );
});

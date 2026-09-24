import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import { palResolve, palShow } from "./pal.js";
import { replicas } from "./pal-causal.test-support.js";

it("inspects a wide offline frontier without repeatedly copying its growing adjacency list", (t) => {
  const { a, b, id, src, dir, track } = replicas(t);
  const root = palShow(a, id)!.heads[0].id;
  const expected: string[] = [];
  for (let branch = 0; branch < 64; branch++) {
    const path = join(dir, `branch-${branch}.db`);
    const fork = track(openMemoryDb(path));
    mergeDb(fork, src);
    const before = palShow(fork, id)!;
    const result = palResolve(fork, id, {
      expectedFrontier: before.frontier,
      choice: { state: { ...before.heads[0].state, detail: `Branch ${branch}` } },
    });
    assert.equal(result.status, "applied");
    expected.push(result.view!.heads[0].id);
    mergeDb(b, path);
  }

  // Count actual element visits, not elapsed time or growing list lengths.
  // This synchronous probe is isolated by Node's per-file test process.
  const lists = new WeakSet<object>();
  const set = Map.prototype.set;
  const iterator = Array.prototype[Symbol.iterator];
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
  let visits = 0;
  t.mock.method(
    Map.prototype,
    "set",
    function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (key === root && Array.isArray(value)) lists.add(value);
      return Reflect.apply(set, this, [key, value]);
    },
  );
  let view;
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      ...iteratorDescriptor,
      value: function* (this: unknown[]) {
        const tracked = lists.has(this);
        const values = Reflect.apply(iterator, this, []);
        for (let step = values.next(); !step.done; step = values.next()) {
          if (tracked) visits++;
          yield step.value;
        }
      },
    });
    view = palShow(b, id)!;
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
    t.mock.restoreAll();
  }
  assert.deepEqual(view.heads.map(({ id }) => id).sort(), expected.sort());
  assert.equal(view.conflict, true);
  t.diagnostic(`adjacency element visits: ${visits} for ${expected.length} edges`);
  assert.ok(visits <= expected.length * 2, "adjacency processing must stay linear in edges");
});

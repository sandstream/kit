import { test } from "node:test";
import {
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";

for (const autoAnchor of [true, false]) {
  test(`append preserves a shortened sealed log (auto-anchor: ${autoAnchor})`, async (t) => {
    const fixture = auditFixture(t, true);
    await runAuditWorkers(
      [
        startAuditWorker(
          fixture,
          `
          const path = join(project, ".kit-audit.jsonl");
          assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
          const first = await readFile(path);
          assert.equal(await audit.appendAuditEventDirect(event("second"), { cwd: project }), true);
          const index = await readFile(anchor.anchorRecordPath());
          await writeFile(path, first);
          assert.deepEqual(audit.verifyAuditChain(first.toString()), { ok: true, entries: 1 });
          process.env.KIT_AUDIT_ANCHOR = ${JSON.stringify(autoAnchor ? "1" : "0")};

          assert.equal(await audit.appendAuditEventDirect(event("later"), { cwd: project }), false);
          assert.deepEqual(await readFile(path), first);
          assert.deepEqual(await readFile(anchor.anchorRecordPath()), index);
        `,
        ),
      ],
      1,
    );
  });
}

test("append preserves the evidence of a missing sealed log", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers(
    [
      startAuditWorker(
        fixture,
        `
        const { rename } = await import("node:fs/promises");
        const path = join(project, ".kit-audit.jsonl");
        assert.equal(await audit.appendAuditEventDirect(event("first"), { cwd: project }), true);
        const bytes = await readFile(path);
        const index = await readFile(anchor.anchorRecordPath());
        await rename(path, path + ".saved");

        assert.equal(await audit.appendAuditEventDirect(event("later"), { cwd: project }), false);
        await assert.rejects(readFile(path), { code: "ENOENT" });
        assert.deepEqual(await readFile(path + ".saved"), bytes);
        assert.deepEqual(await readFile(anchor.anchorRecordPath()), index);
      `,
      ),
    ],
    1,
  );
});

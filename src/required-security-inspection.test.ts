import assert from "node:assert/strict";
import { it } from "node:test";
import { runRequiredInspection } from "./required-security-inspection.js";

it("derives the verdict from evidence and distinguishes why evidence is absent", async () => {
  const base = { category: "secrets", name: "required check" } as const;
  const decide = (evidence: string) =>
    evidence === "complete" ? { ...base, status: "pass" as const, detail: evidence } : null;
  const unavailable = ({ kind }: { kind: string }) => ({
    ...base,
    status: "fail" as const,
    detail: kind,
    didNotRun: true,
  });

  assert.equal((await runRequiredInspection(() => "complete", decide, unavailable)).status, "pass");
  assert.equal((await runRequiredInspection(null, decide, unavailable)).detail, "unavailable");
  assert.equal(
    (await runRequiredInspection(() => "partial", decide, unavailable)).detail,
    "incomplete",
  );
  const result = await runRequiredInspection(
    async () => {
      throw new Error("inspection failed");
    },
    decide,
    unavailable,
  );
  assert.equal(result.status, "fail");
  assert.equal(result.detail, "failed");
});

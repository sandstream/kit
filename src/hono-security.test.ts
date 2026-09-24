import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";

// Hono ships through the MCP SDK but is not loaded by Kit's stdio transport.
// Exercise the installed dependency so a vulnerable override cannot silently return.
it("Hono excludes URL fragments from single and multi-value query parameters", async () => {
  const app = new Hono();
  app.get("/", (context) =>
    context.json({
      query: context.req.query(),
      role: context.req.query("role"),
      roles: context.req.queries("role"),
    }),
  );

  const cases = [
    { suffix: "#?role=admin", expected: { query: {} } },
    {
      suffix: "?role=reader#&role=admin",
      expected: { query: { role: "reader" }, role: "reader", roles: ["reader"] },
    },
    {
      suffix: "?role=reader&role=staff",
      expected: {
        query: { role: "reader" },
        role: "reader",
        roles: ["reader", "staff"],
      },
    },
    {
      suffix: "?role=reader%23staff#?role=admin",
      expected: {
        query: { role: "reader#staff" },
        role: "reader#staff",
        roles: ["reader#staff"],
      },
    },
  ];
  for (const { suffix, expected } of cases) {
    const response = await app.request(new Request(`https://kit.invalid/${suffix}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected, suffix);
  }
});

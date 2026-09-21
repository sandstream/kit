import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMonkeyTestPlan } from "./monkey-test-plan.js";
import { withoutMonkeySourceComments } from "./monkey-test-scan.js";

async function planForSource(source: string, file = "checkout.js") {
  const root = await mkdtemp(join(tmpdir(), "kit-monkey-comments-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "src", file), source);
    return await buildMonkeyTestPlan(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const source of [
  'const caption = `${/* new Stripe(key); */ "checkout"}`;',
  'const caption = `${// loadStripe(key);\n "checkout"}`;',
  'const caption = `${({label: `nested ${/* new Stripe(key); */ "checkout"}`}).label}`;',
]) {
  it(`ignores comments inside executable template interpolation: ${source}`, async () => {
    new Function(source)();
    const plan = await planForSource(source);
    assert.deepEqual(plan.money.providers, []);
    assert.ok(!plan.findings.some((finding) => finding.area === "money"));
  });
}

for (const source of [
  "const caption = `${/* stale new Stripe(key); */ loadStripe(key)}`;",
  "const caption = `${({label: `nested ${loadStripe(key)}`}).label}`;",
  "const url = `https://example.com/${loadStripe(key)}`;",
]) {
  it(`keeps real payment calls inside template interpolation: ${source}`, async () => {
    let calls = 0;
    new Function("loadStripe", "key", source)(() => calls++, "test-key");
    assert.equal(calls, 1);
    assert.deepEqual((await planForSource(source)).money.providers, ["stripe"]);
  });
}

it("ignores commented HTML SDK tags but detects the same active tags", async () => {
  const script = '<script src="https://js.stripe.com/v3/"></script>';
  const commented = await planForSource(`<p>Don't pay yet</p>\n<!--\n${script}\n-->`, "index.html");
  assert.deepEqual(commented.money.providers, []);
  assert.ok(!commented.findings.some((finding) => finding.area === "money"));
  const active = await planForSource(script, "index.html");
  assert.deepEqual(active.money.providers, ["stripe"]);
  assert.ok(active.findings.some((finding) => finding.area === "money"));
});

it("handles inline HTML scripts without removing SDK URLs in JavaScript strings", async () => {
  const commented = '<script>const label = `${/* new Stripe(key); */ "checkout"}`;</script>';
  assert.deepEqual((await planForSource(commented, "index.html")).money.providers, []);
  const active = '<script>const html = "<!-- https://js.stripe.com/v3/ -->";</script>';
  assert.deepEqual((await planForSource(active, "index.html")).money.providers, ["stripe"]);
});

it("keeps SQL and hash comments language-specific while preserving literals and line numbers", () => {
  const sources = {
    "query.sql": "select 1; -- new Stripe(key);\nselect 'https://js.stripe.com/v3/';",
    "app.py": 'name = "ready" # new Stripe(key);\nurl = "https://js.stripe.com/v3/"',
    "checkout.js": 'let attempts = 3; attempts--;\nconst url = "https://js.stripe.com/v3/";',
  };
  const clean = withoutMonkeySourceComments(sources);
  assert.doesNotMatch(clean["query.sql"], /new Stripe/);
  assert.doesNotMatch(clean["app.py"], /new Stripe/);
  assert.match(clean["checkout.js"], /attempts--/);
  for (const [path, source] of Object.entries(sources)) {
    assert.ok(clean[path].includes("https://js.stripe.com/v3/"));
    assert.equal(clean[path].split("\n").length, source.split("\n").length);
  }
});

for (const source of [
  "let attempts = 3; if (--attempts > 0) loadStripe(key);",
  "let attempts = 3; attempts--; loadStripe(key);",
]) {
  it(`keeps executable payment calls after JavaScript decrement: ${source}`, async () => {
    let calls = 0;
    new Function("loadStripe", "key", source)(() => calls++, "test-key");
    assert.equal(calls, 1);
    const plan = await planForSource(source);
    assert.deepEqual(plan.money.providers, ["stripe"]);
    assert.ok(plan.findings.some((finding) => finding.area === "money"));
  });
}

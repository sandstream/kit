import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectPaymentProviders,
  scanMonkeySources,
  withoutMonkeySourceComments,
} from "./monkey-test-scan.js";

describe("monkey-test source scan", () => {
  it("separates runtime source from docs and detects real payment integrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-monkey-scan-"));
    try {
      await mkdir(join(root, "src"));
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "src", "checkout.ts"), 'import Stripe from "stripe";\n');
      await writeFile(join(root, "docs", "payments.md"), "PayPal integration example\n");

      const scan = await scanMonkeySources(root);
      assert.ok("src/checkout.ts" in scan.runtimeFiles);
      assert.ok(!("docs/payments.md" in scan.runtimeFiles));
      assert.deepEqual(detectPaymentProviders({}, scan.runtimeText), ["stripe"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes comments while preserving string literals", () => {
    const cleaned = withoutMonkeySourceComments({
      "src/a.ts": '// Stripe.fake()\nconst provider = "stripe";\n',
    });
    assert.ok(!cleaned["src/a.ts"].includes("Stripe.fake"));
    assert.ok(cleaned["src/a.ts"].includes('"stripe"'));
  });
});

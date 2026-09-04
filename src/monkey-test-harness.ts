import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  MONKEY_MANAGED,
  MONKEY_ROLES,
  type HarnessWrite,
  type HarnessWriteResult,
} from "./monkey-test-contract.js";
import { monkeySpec } from "./monkey-test-harness-spec.js";
import { readMonkeyText } from "./monkey-test-scan.js";

function generatedHeader(path: string): string {
  return `// ${MONKEY_MANAGED}. Edit source in kit or re-run \`kit monkey-test init --force\`.\n// File: ${path}\n\n`;
}

function roleMatrixJson(): string {
  return (
    JSON.stringify(
      {
        generatedBy: "kit monkey-test",
        configured: false,
        roles: MONKEY_ROLES.map((role) => ({
          ...role,
          allowRoutes: ["/"],
          denyRoutes: [`/replace-with-route-denied-to-${role.id}`],
          requiredText: [`replace-with-seeded-own-org-marker-for-${role.id}`],
          forbiddenText: [`replace-with-seeded-other-org-marker-for-${role.id}`],
        })),
        note: "Replace every placeholder from the idempotent seed, then set configured to true. Staff is kiosk staff, separate from owner/admin and kiosk device state.",
      },
      null,
      2,
    ) + "\n"
  );
}

function expectedFindingsJson(): string {
  return (
    JSON.stringify(
      [
        {
          area: "ux",
          role: "public",
          route: "/maintenance",
          title: "Known maintenance banner",
          reason: "Launch-day maintenance banner is approved by product until 2026-09-15.",
        },
      ],
      null,
      2,
    ) + "\n"
  );
}

const PLAYWRIGHT_CONFIG_LINES = [
  'import { defineConfig, devices } from "@playwright/test";',
  "",
  'const rawPort = Number(process.env.KIT_MONKEY_PORT ?? process.env.PORT ?? "0");',
  "const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 0;",
  "const baseURL =",
  '  process.env.MONKEY_BASE_URL ?? (port > 0 ? `http://127.0.0.1:${port}` : "http://127.0.0.1:4173");',
  "",
  "export default defineConfig({",
  '  testDir: "./tests/monkey",',
  "  metadata: { kitMonkeyContract: 1, kitMonkeyRunId: process.env.MONKEY_RUN_ID },",
  "  timeout: 60_000,",
  "  expect: { timeout: 10_000 },",
  "  fullyParallel: false,",
  "  reporter: [",
  '    ["list"],',
  '    ["json", { outputFile: ".kit/monkey-test/playwright-report.json" }],',
  "  ],",
  "  use: {",
  "    baseURL,",
  '    trace: "retain-on-failure",',
  '    screenshot: "only-on-failure",',
  '    video: "retain-on-failure",',
  "  },",
  "  projects: [",
  "    {",
  '      name: "desktop-chromium",',
  '      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },',
  "    },",
  "    {",
  '      name: "mobile-chrome",',
  '      use: { ...devices["Pixel 7"] },',
  "    },",
  "  ],",
  "});",
  "",
];

function playwrightConfig(): string {
  return generatedHeader("playwright.monkey.config.ts") + PLAYWRIGHT_CONFIG_LINES.join("\n");
}

function harnessReadme(): string {
  return `# Monkey Test

${MONKEY_MANAGED}.

Role-based release gate for applications that handle money. The harness crawls
desktop and mobile routes as public visitor, customer/buyer, kiosk staff,
owner/admin, and superadmin/support, then fails on broken UX, browser runtime
errors, missing auth fixtures, inaccessible controls, and an unconfigured money
flow.

Run through kit so the runner gets a free local port and a temporary env:

\`\`\`sh
kit monkey-test run \\
  --env-command 'your-vault-or-provider-cli export --format=dotenv' \\
  --seed-command 'npm run seed:test'
\`\`\`

If the temporary env command fails or contains live payment configuration, kit
stops before running seed, dev server, or browser commands.

Before running, replace every placeholder in
\`.kit/monkey-test/role-matrix.json\`. Give each role non-empty
\`allowRoutes\`, \`denyRoutes\`, seeded positive-control \`requiredText\`, and
cross-org \`forbiddenText\`, then
set \`configured\` to \`true\`. The gate fails closed until this is done.

Useful env:

- \`MONKEY_ROLE_MATRIX=.kit/monkey-test/role-matrix.json\`
- \`MONKEY_LINK_DEPTH=2\`
- \`MONKEY_CUSTOMER_STATE=.auth/customer.json\`
- \`MONKEY_STAFF_STATE=.auth/staff.json\`
- \`MONKEY_OWNER_STATE=.auth/owner.json\`
- \`MONKEY_SUPERADMIN_STATE=.auth/superadmin.json\`
- \`MONKEY_MONEY_ROUTE=/shop\`
- \`MONKEY_ADD_TO_CART='button:has-text("Add")'\`
- \`MONKEY_CHECKOUT='a:has-text("Checkout"),button:has-text("Checkout")'\`
- \`MONKEY_PAYMENT_MODE=test\`
- \`MONKEY_PAYMENT_SHELL=<selector>\` and \`MONKEY_SANDBOX_INDICATOR=<selector>\`
- \`MONKEY_PAYMENT_ACTION=cancel\`, \`MONKEY_CANCEL_PAYMENT=<selector>\`, and
  \`MONKEY_CANCELLED_STATE=<selector>\`
- For sandbox confirmation, use \`MONKEY_PAYMENT_ACTION=confirm\`,
  \`MONKEY_CONFIRM_PAYMENT=<selector>\`, and \`MONKEY_CONFIRMED_STATE=<selector>\`.

Do not silence failures with broad skips. Use \`MONKEY_EXPECTED_FINDINGS\` with a
specific \`title\`, \`role\`, \`route\`, and \`reason\`, or
\`MONKEY_SKIP_MONEY_FLOW=1 MONKEY_EXPECTED_REASON=...\` only when the release
owner has accepted the gap. A custom test command passes only when it preserves
the generated JSON report for the current run and covers desktop, mobile, every
role, and the money flow.
`;
}

function securityChecklist(): string {
  return `# Monkey Test Security Checklist

${MONKEY_MANAGED}.

Gate these before release:

- RLS/RPC authorization covers public, customer, kiosk staff, owner/admin, and superadmin/support.
- Cross-org isolation is asserted on reads, writes, payment objects, webhooks, exports, and support tools.
- Webhook signatures are verified before parsing provider payloads.
- Webhook idempotency stores provider event IDs and makes side effects replay-safe.
- Storage buckets default private; public buckets are deliberate static-asset exceptions.
- No committed secrets or live payment keys. Runtime env for this gate uses sandbox/test keys only.
- CSP and security headers cover app routes plus sandbox payment domains.
- Stripe/Connect, PayPal, Adyen, or other money rails run in sandbox/test mode only.
- Refunds, receipts, and payout/journal events are append-only and immutable after settlement.
`;
}

function harnessFiles(): Record<string, string> {
  return {
    "playwright.monkey.config.ts": playwrightConfig(),
    "tests/monkey/monkey.spec.ts": monkeySpec(generatedHeader("tests/monkey/monkey.spec.ts")),
    "tests/monkey/README.md": harnessReadme(),
    "tests/monkey/security-checklist.md": securityChecklist(),
    ".kit/monkey-test/role-matrix.json": roleMatrixJson(),
    ".kit/monkey-test/expected-findings.example.json": expectedFindingsJson(),
  };
}

async function writeManaged(
  root: string,
  relPath: string,
  content: string,
  force: boolean,
): Promise<HarnessWrite> {
  const path = join(root, relPath);
  const before = await readMonkeyText(path);
  if (before === content) return { path: relPath, action: "unchanged" };
  if (before && !before.includes(MONKEY_MANAGED) && !force) {
    return {
      path: relPath,
      action: "skipped",
      reason: "exists and is not kit-managed; pass --force to overwrite",
    };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return { path: relPath, action: before ? "updated" : "created" };
}

export async function writeMonkeyHarness(
  cwd: string = process.cwd(),
  opts: { force?: boolean } = {},
): Promise<HarnessWriteResult> {
  const root = resolve(cwd);
  const writes: HarnessWrite[] = [];
  for (const [relPath, content] of Object.entries(harnessFiles())) {
    writes.push(await writeManaged(root, relPath, content, opts.force === true));
  }
  return { ok: writes.every((write) => write.action !== "skipped"), writes };
}

import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  MONKEY_MANAGED,
  MONKEY_ROLES,
  type HarnessWrite,
  type HarnessWriteResult,
} from "./monkey-test-contract.js";
import { monkeySpec } from "./monkey-test-harness-spec.js";

const OPERATOR_CONFIG_FILES = new Set([
  "playwright.monkey.config.ts",
  ".kit/monkey-test/role-matrix.json",
  ".kit/monkey-test/expected-findings.example.json",
]);

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
  return (
    `// ${MONKEY_MANAGED}. Operator configuration; init preserves this file.\n\n` +
    PLAYWRIGHT_CONFIG_LINES.join("\n")
  );
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
owner has accepted the gap. Payment shell, sandbox indicator, action, and final
state require distinct, specific selectors; \`body\`, \`html\`, \`:root\`, and
universal selectors are not evidence. A custom test command is diagnostic only
and cannot attest browser execution; the release gate runs the generated monkey
Playwright config directly.
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

async function harnessFileStat(path: string): Promise<Stats | null> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function harnessDirectory(root: string, relPath: string, create: boolean): Promise<boolean> {
  let directory = root;
  for (const segment of relPath.split("/").slice(0, -1)) {
    directory = join(directory, segment);
    if (create) {
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    if (!(await harnessFileStat(directory))?.isDirectory()) return false;
  }
  return true;
}

function sameHarnessFile(before: Stats, after: Stats | null): boolean {
  return (
    !!after &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    after.isFile() &&
    after.nlink === 1 &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

export async function readHarnessFile(
  path: string,
  expected: Stats,
  noFollowFlag: number | null = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : null,
): Promise<string | null> {
  const file = await open(
    path,
    constants.O_RDONLY | (noFollowFlag ?? 0) | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (["ENOENT", "ELOOP"].includes(error.code ?? "")) return null;
    throw error;
  });
  if (!file) return null;
  try {
    if (!sameHarnessFile(expected, await file.stat())) return null;
    if (!sameHarnessFile(expected, await harnessFileStat(path))) return null;
    const content = await file.readFile("utf8");
    return sameHarnessFile(expected, await file.stat()) &&
      sameHarnessFile(expected, await harnessFileStat(path))
      ? content
      : null;
  } finally {
    await file.close();
  }
}

async function publishHarnessFile(
  root: string,
  relPath: string,
  content: string,
  existing: Stats | null,
): Promise<boolean> {
  const path = join(root, relPath);
  const staging = await mkdtemp(join(dirname(path), ".kit-monkey-"));
  try {
    const temporary = join(staging, "content");
    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: existing ? existing.mode & 0o777 : 0o644,
    });
    if (!(await harnessDirectory(root, relPath, false))) return false;
    const current = await harnessFileStat(path);
    if (existing ? !sameHarnessFile(existing, current) : current !== null) return false;
    // Rename replaces the leaf entry, never its linked inode. Parent-directory rename
    // races remain outside this path-based API's guarantee (no directory handles).
    if (existing) await rename(temporary, path);
    else await link(temporary, path);
    return true;
  } catch (error) {
    if (
      ["EEXIST", "EISDIR", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return false;
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function scaffoldPreservationReason(before: string, force: boolean): string | undefined {
  if (!before.includes(MONKEY_MANAGED)) {
    return "operator-owned file preserved; only generated scaffold can be refreshed";
  }
  if (!force) return "exists with different content; pass --force to refresh generated scaffold";
  return undefined;
}

async function writeManaged(
  root: string,
  relPath: string,
  content: string,
  force: boolean,
): Promise<HarnessWrite> {
  const path = join(root, relPath);
  if (!(await harnessDirectory(root, relPath, true))) {
    return { path: relPath, action: "skipped", reason: "parent is not a regular directory" };
  }
  const existing = await harnessFileStat(path);
  if (existing && (!existing.isFile() || existing.nlink !== 1)) {
    return {
      path: relPath,
      action: "skipped",
      reason: "destination is not a regular file with one link",
    };
  }
  if (existing && OPERATOR_CONFIG_FILES.has(relPath)) {
    return { path: relPath, action: "unchanged", reason: "operator configuration preserved" };
  }
  const before = existing ? await readHarnessFile(path, existing) : null;
  if (existing && before === null) {
    return {
      path: relPath,
      action: "skipped",
      reason: "destination changed or cannot be read without following links",
    };
  }
  if (before === content) return { path: relPath, action: "unchanged" };
  const reason = before === null ? undefined : scaffoldPreservationReason(before, force);
  if (reason) return { path: relPath, action: "skipped", reason };
  if (!(await publishHarnessFile(root, relPath, content, existing))) {
    return { path: relPath, action: "skipped", reason: "destination changed during init" };
  }
  return { path: relPath, action: existing ? "updated" : "created" };
}

export async function writeMonkeyHarness(
  cwd: string = process.cwd(),
  opts: { force?: boolean } = {},
): Promise<HarnessWriteResult> {
  await mkdir(resolve(cwd), { recursive: true });
  const root = await realpath(resolve(cwd));
  const writes: HarnessWrite[] = [];
  for (const [relPath, content] of Object.entries(harnessFiles())) {
    writes.push(await writeManaged(root, relPath, content, opts.force === true));
  }
  return { ok: writes.every((write) => write.action !== "skipped"), writes };
}

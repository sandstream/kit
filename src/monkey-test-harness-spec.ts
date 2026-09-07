import {
  MONKEY_ROLE_IDS,
  MONKEY_ROLE_LIST_KEYS,
  MONKEY_ROLE_ROUTE_KEYS,
  configuredRoleEntries,
  controlHasAccessibleName,
  focusableIsOffscreen,
  isRoleWithId,
  matchesExpectedFinding,
  requireDisjointValues,
  requireSameOriginRoutes,
  requiredRole,
  requiredStringList,
  unexpectedMonkeyFindings,
  validateExpectedFindings,
  validateMoneyFlowConfig,
  validateRoleExpectation,
  validateRoleMatrix,
} from "./monkey-test-contract.js";

const SPEC_PREAMBLE = `import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

type Severity = "critical" | "high" | "medium" | "low";
type Finding = {
  severity: Severity;
  area: "runner" | "ux" | "a11y" | "i18n" | "money" | "authz" | "security";
  title: string;
  role: string;
  route: string;
  repro: string;
  file?: string;
  fix: string;
};
type ExpectedFinding = Partial<Finding> & { reason?: string };
type RoleExpectation = {
  id: "public" | "customer" | "staff" | "owner" | "superadmin";
  allowRoutes: string[];
  denyRoutes: string[];
  requiredText: string[];
  forbiddenText: string[];
};
type ControlName = {
  visibleText?: string;
  buttonValue?: string;
  ariaLabel?: string;
  title?: string;
  associatedLabel?: string;
  labelledByText?: string;
  imageAlt?: string;
};
type FocusableGeometry = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  viewportWidth: number;
  viewportHeight: number;
  display: string;
  visibility: string;
};
type MoneyFlowConfig = {
  mode: "test" | "sandbox";
  action: "cancel" | "confirm";
  route: string;
  addToCart: string;
  checkout: string;
  paymentShell: string;
  sandboxIndicator: string;
  actionControl: string;
  finalState: string;
};

const roles = [
  { id: "public", label: "Public visitor" },
  { id: "customer", label: "Customer/buyer", env: "MONKEY_CUSTOMER_STATE", fallback: ".auth/customer.json" },
  { id: "staff", label: "Kiosk staff", env: "MONKEY_STAFF_STATE", fallback: ".auth/staff.json" },
  { id: "owner", label: "Owner/admin", env: "MONKEY_OWNER_STATE", fallback: ".auth/owner.json" },
  { id: "superadmin", label: "Superadmin/support", env: "MONKEY_SUPERADMIN_STATE", fallback: ".auth/superadmin.json" },
] as const;

const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function storageState(role: (typeof roles)[number]): string | undefined {
  if (!("env" in role)) return undefined;
  const path = process.env[role.env] ?? role.fallback;
  return existsSync(path) ? path : undefined;
}

`;

function embeddedContractSource(): string {
  return `const validateExpectedFindings: (value: unknown) => ExpectedFinding[] = ${validateExpectedFindings.toString()};
const matchesExpectedFinding: (actual: Finding, expected: ExpectedFinding) => boolean = ${matchesExpectedFinding.toString()};
const unexpectedMonkeyFindings: (findings: Finding[], expected: unknown) => Finding[] = ${unexpectedMonkeyFindings.toString()};
const MONKEY_ROLE_IDS = ${JSON.stringify(MONKEY_ROLE_IDS)} as const;
const MONKEY_ROLE_LIST_KEYS = ${JSON.stringify(MONKEY_ROLE_LIST_KEYS)} as const;
const MONKEY_ROLE_ROUTE_KEYS = ${JSON.stringify(MONKEY_ROLE_ROUTE_KEYS)} as const;
type MonkeyRoleListKey = (typeof MONKEY_ROLE_LIST_KEYS)[number];
const isRoleWithId: (candidate: unknown, id: RoleExpectation["id"]) => candidate is Record<string, unknown> = ${isRoleWithId.toString()};
const configuredRoleEntries: (value: unknown) => unknown[] = ${configuredRoleEntries.toString()};
const requiredRole: (entries: unknown[], id: RoleExpectation["id"]) => Record<string, unknown> = ${requiredRole.toString()};
const requiredStringList: (role: Record<string, unknown>, id: RoleExpectation["id"], key: MonkeyRoleListKey) => string[] = ${requiredStringList.toString()};
const requireSameOriginRoutes: (routes: string[], id: RoleExpectation["id"], key: (typeof MONKEY_ROLE_ROUTE_KEYS)[number]) => void = ${requireSameOriginRoutes.toString()};
const requireDisjointValues: (included: string[], excluded: string[], message: string) => void = ${requireDisjointValues.toString()};
const validateRoleExpectation: (role: Record<string, unknown>, id: RoleExpectation["id"]) => void = ${validateRoleExpectation.toString()};
const validateRoleMatrix: (value: unknown) => RoleExpectation[] = ${validateRoleMatrix.toString()};
const controlHasAccessibleName: (control: ControlName) => boolean = ${controlHasAccessibleName.toString()};
const focusableIsOffscreen: (geometry: FocusableGeometry) => boolean = ${focusableIsOffscreen.toString()};
const validateMoneyFlowConfig: (env: Record<string, string | undefined>) => MoneyFlowConfig = ${validateMoneyFlowConfig.toString()};
`;
}

const SPEC_BODY = `
function loadExpected(): unknown {
  const path = process.env.MONKEY_EXPECTED_FINDINGS;
  if (!path) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadRoleMatrix(): RoleExpectation[] {
  const path = process.env.MONKEY_ROLE_MATRIX ?? ".kit/monkey-test/role-matrix.json";
  return validateRoleMatrix(JSON.parse(readFileSync(path, "utf-8")));
}

const roleExpectations = loadRoleMatrix();

function summarize(findings: Finding[]): string {
  return findings
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
    .map(
      (f) =>
        \`[\${f.severity}] \${f.area} \${f.role} \${f.route}: \${f.title}\\n  repro: \${f.repro}\\n  fix: \${f.fix}\${f.file ? \`\\n  file: \${f.file}\` : ""}\`,
    )
    .join("\\n");
}

async function collectLinks(page: Page, depth: number): Promise<string[]> {
  if (depth <= 0) return [];
  return await page.locator("a[href]").evaluateAll((nodes) => {
    const origin = location.origin;
    return Array.from(nodes)
      .map((node) => (node as HTMLAnchorElement).href)
      .filter((href) => href.startsWith(origin))
      .map((href) => new URL(href).pathname + new URL(href).search);
  });
}

function routePath(urlOrPath: string): string {
  return new URL(urlOrPath, process.env.MONKEY_BASE_URL ?? "http://127.0.0.1").pathname;
}

async function routeIsDenied(page: Page, status: number, requestedRoute: string): Promise<boolean> {
  if ([401, 403, 404].includes(status)) return true;
  const redirected = routePath(page.url()) !== routePath(requestedRoute);
  if (redirected && /login|sign-in|unauthorized|forbidden|access-denied/i.test(routePath(page.url()))) {
    return true;
  }
  return (await page.getByText(/access denied|forbidden|not authorized|sign in to continue/i).count()) > 0;
}

async function isolationFindings(
  page: Page,
  role: string,
  route: string,
  forbiddenText: string[],
): Promise<Finding[]> {
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return forbiddenText
    .filter((marker) => body.includes(marker))
    .map((marker) => ({
      severity: "critical" as const,
      area: "authz" as const,
      title: "Cross-org isolation marker visible",
      role,
      route,
      repro: \`Seed marker visible: \${marker}\`,
      fix: "Scope server queries and rendered data to the authenticated tenant, then re-run every role.",
    }));
}

async function inspectPage(page: Page, role: string, route: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const controls = page.locator("button:not([disabled]),input:not([type='hidden']):not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[role='button']:not([aria-disabled='true']),[role='link']:not([aria-disabled='true'])");
  const controlCount = await controls.count().catch(() => 0);
  const limit = envInt("MONKEY_CONTROL_BLOAT_LIMIT", 80);
  if (controlCount > limit) {
    findings.push({
      severity: "medium",
      area: "ux",
      title: \`Control bloat: \${controlCount} controls exceed limit \${limit}\`,
      role,
      route,
      repro: \`MONKEY_CONTROL_BLOAT_LIMIT=\${limit} npx playwright test -c playwright.monkey.config.ts\`,
      fix: "Split the route into task-focused surfaces, hide advanced controls behind menus, or tighten role permissions.",
    });
  }

  const controlNames = await controls.evaluateAll((nodes) =>
    nodes.map((node) => {
      const el = node as HTMLElement;
      const input = el instanceof HTMLInputElement ? el : null;
      const labels = input || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
        ? Array.from(el.labels ?? []).map((label) => label.textContent ?? "").join(" ")
        : "";
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const buttonValue = input && ["button", "submit", "reset"].includes(input.type) ? input.value : "";
      const imageAlt = Array.from(el.querySelectorAll("img[alt]"))
        .map((image) => image.getAttribute("alt") ?? "")
        .join(" ");
      return {
        html: el.outerHTML.slice(0, 160),
        name: {
          visibleText: el.innerText,
          buttonValue,
          ariaLabel: el.getAttribute("aria-label") ?? "",
          title: el.getAttribute("title") ?? "",
          associatedLabel: labels,
          labelledByText: labelledBy,
          imageAlt,
        },
      };
    }),
  );
  for (const { html } of controlNames.filter((control) => !controlHasAccessibleName(control.name)).slice(0, 5)) {
    findings.push({
      severity: "medium",
      area: "a11y",
      title: "Unlabeled interactive control",
      role,
      route,
      repro: html,
      fix: "Add visible text or an aria-label/title that describes the control action.",
    });
  }

  const focusableGeometry = await page
    .locator("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const el = node as HTMLElement;
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            html: el.outerHTML.slice(0, 160),
            geometry: {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              viewportWidth: innerWidth,
              viewportHeight: innerHeight,
              display: style.display,
              visibility: style.visibility,
            },
          };
        })
    );
  for (const { html } of focusableGeometry.filter((control) => focusableIsOffscreen(control.geometry)).slice(0, 5)) {
    findings.push({
      severity: "high",
      area: "a11y",
      title: "Focusable control is offscreen",
      role,
      route,
      repro: html,
      fix: "Remove it from tab order while hidden, or keep the focused element inside the viewport.",
    });
  }

  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const textChecks: [RegExp, Severity, Finding["area"], string, string][] = [
    [/translation missing|missing translation|i18n missing|__MSG_/i, "medium", "i18n", "Missing translation marker", "Add the missing locale key or remove the placeholder."],
    [/\\bundefined\\b|\\bnull\\b|NaN|\\[object Object\\]/i, "high", "ux", "Fatal UI copy placeholder", "Render a real empty/error state instead of leaking runtime placeholders."],
    [/lorem ipsum|todo:|coming soon/i, "medium", "ux", "Unfinished UI copy", "Replace placeholder copy or mark the route expected with a release owner reason."],
  ];
  for (const [pattern, severity, area, title, fix] of textChecks) {
    if (pattern.test(body)) {
      findings.push({ severity, area, title, role, route, repro: pattern.source, fix });
    }
  }

  const loading = await page.getByText(/loading|laddar|spinner/i).count().catch(() => 0);
  if (loading > 0) {
    findings.push({
      severity: "medium",
      area: "ux",
      title: "Loading state still visible after page settled",
      role,
      route,
      repro: "page.getByText(/loading|laddar|spinner/i)",
      fix: "Resolve the underlying request, add timeout/error copy, or hide completed loading indicators.",
    });
  }

  const emptyOrError = /\\b(no .*found|no results|empty|error|failed)\\b/i.test(body);
  if (emptyOrError && controlCount === 0) {
    findings.push({
      severity: "medium",
      area: "ux",
      title: "Empty/error state has no actionable control",
      role,
      route,
      repro: "Route contains empty/error copy and zero controls",
      fix: "Add a clear recovery action appropriate for the role.",
    });
  }
  return findings;
}

for (const role of roles) {
  test.describe(\`\${role.id}: \${role.label}\`, () => {
    const state = storageState(role);
    const expectation = roleExpectations.find((item) => item.id === role.id)!;
    if (state) test.use({ storageState: state });

    test("route crawl", async ({ page }, testInfo) => {
      const findings: Finding[] = [];
      const observedRequiredText = new Set<string>();
      if (role.id !== "public" && !state) {
        findings.push({
          severity: "critical",
          area: "authz",
          title: \`Missing auth state for \${role.label}\`,
          role: role.id,
          route: "*",
          repro: \`Set \${"env" in role ? role.env : "MONKEY_AUTH_STATE"} or create \${"fallback" in role ? role.fallback : ".auth/user.json"}\`,
          fix: "Create deterministic storageState fixtures during idempotent seed/login setup.",
        });
      }

      const responses: Finding[] = [];
      const consoleErrors: Finding[] = [];
      let crawlingDeniedRoute = false;
      page.on("response", (response) => {
        const status = response.status();
        const expectedAuthFailure =
          crawlingDeniedRoute && [401, 403, 404].includes(status);
        if (status >= 400 && !response.request().isNavigationRequest() && !expectedAuthFailure) {
          responses.push({
            severity: status >= 500 ? "critical" : "high",
            area: "ux",
            title: \`HTTP \${status}\`,
            role: role.id,
            route: response.url(),
            repro: response.url(),
            fix: "Fix the failing request or block the route from this role intentionally.",
          });
        }
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push({
            severity: "high",
            area: "ux",
            title: "Console error",
            role: role.id,
            route: page.url(),
            repro: message.text(),
            fix: "Fix browser console errors; hydration/runtime errors are release blockers.",
          });
        }
      });
      page.on("pageerror", (error) => {
        consoleErrors.push({
          severity: "critical",
          area: "ux",
          title: "Page error",
          role: role.id,
          route: page.url(),
          repro: error.message,
          fix: "Fix uncaught browser exceptions before release.",
        });
      });

      for (const route of expectation.denyRoutes) {
        let navigationError = "";
        crawlingDeniedRoute = true;
        const response = await page.goto(route, { waitUntil: "domcontentloaded" }).catch((error) => {
          navigationError = String(error);
          return null;
        });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        crawlingDeniedRoute = false;
        if (!response) {
          findings.push({
            severity: "critical",
            area: "authz",
            title: "Denied-route authorization could not be verified",
            role: role.id,
            route,
            repro: navigationError || \`No response for \${route}\`,
            fix: "Keep the denied route reachable in test mode and return an intentional 401, 403, 404, or access-denied redirect.",
          });
        } else if (response.status() >= 500) {
          findings.push({
            severity: "critical",
            area: "ux",
            title: \`HTTP \${response.status()} on denied route\`,
            role: role.id,
            route,
            repro: response.url(),
            fix: "Return an intentional authorization denial instead of a server error.",
          });
        } else if (!(await routeIsDenied(page, response.status(), route))) {
          findings.push({
            severity: "critical",
            area: "authz",
            title: "Denied route exposed",
            role: role.id,
            route,
            repro: \`GET \${route} returned \${response.status()} at \${page.url()}\`,
            fix: "Enforce route authorization server-side and assert this role remains denied.",
          });
        }
      }

      const maxDepth = envInt("MONKEY_LINK_DEPTH", 2);
      const visited = new Set<string>();
      let frontier = expectation.allowRoutes;
      for (let depth = 0; depth <= maxDepth; depth++) {
        const next = new Set<string>();
        for (const route of frontier) {
          if (visited.has(route) || expectation.denyRoutes.includes(route)) continue;
          visited.add(route);
          let navigationError = "";
          const response = await page.goto(route, { waitUntil: "domcontentloaded" }).catch((error) => {
            navigationError = String(error);
            return null;
          });
          if (!response) {
            findings.push({
              severity: "critical",
              area: "ux",
              title: "Route navigation failed",
              role: role.id,
              route,
              repro: navigationError || \`No response for \${route}\`,
              fix: "Make the route reachable for this role or remove it from the role matrix allowRoutes.",
            });
            continue;
          }
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
          if (response.status() >= 500) {
            findings.push({
              severity: "critical",
              area: "ux",
              title: \`HTTP \${response.status()}\`,
              role: role.id,
              route,
              repro: response.url(),
              fix: "Fix the server error before release.",
            });
            continue;
          }
          if (await routeIsDenied(page, response.status(), route)) {
            findings.push({
              severity: expectation.allowRoutes.includes(route) ? "critical" : "high",
              area: "authz",
              title: expectation.allowRoutes.includes(route)
                ? "Allowed route denied"
                : "Visible link denied to role",
              role: role.id,
              route,
              repro: \`GET \${route} returned \${response.status()} at \${page.url()}\`,
              fix: "Align navigation visibility and route authorization with the role matrix.",
            });
            continue;
          }
          findings.push(...(await inspectPage(page, role.id, route)));
          findings.push(...(await isolationFindings(page, role.id, route, expectation.forbiddenText)));
          const pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
          for (const marker of expectation.requiredText) {
            if (pageText.includes(marker)) observedRequiredText.add(marker);
          }
          for (const link of await collectLinks(page, maxDepth - depth)) next.add(link);
        }
        frontier = [...next];
      }

      for (const marker of expectation.requiredText) {
        if (observedRequiredText.has(marker)) continue;
        findings.push({
          severity: "critical",
          area: "authz",
          title: "Required role marker missing",
          role: role.id,
          route: expectation.allowRoutes.join(","),
          repro: \`Seeded positive-control marker was not visible: \${marker}\`,
          fix: "Fix the role fixture/seed or route access before trusting negative cross-org assertions.",
        });
      }

      findings.push(...responses, ...consoleErrors);
      const open = unexpectedMonkeyFindings(findings, loadExpected());
      await testInfo.attach("monkey-findings.json", {
        body: JSON.stringify(open, null, 2),
        contentType: "application/json",
      });
      expect(open, summarize(open)).toEqual([]);
    });
  });
}

const customer = roles.find((role) => role.id === "customer")!;
const customerState = storageState(customer);
test.describe("customer payment", () => {
  if (customerState) test.use({ storageState: customerState });

  test("money flow", async ({ page }) => {
    const liveKeys = Object.entries(process.env)
      .filter(([key, value]) => /STRIPE|PAYMENT|CONNECT/i.test(key) && /^(sk|pk|rk)_live_/.test(value ?? ""))
      .map(([key]) => key);
    expect(liveKeys, \`Live payment env keys are not allowed in monkey-test: \${liveKeys.join(", ")}\`).toEqual([]);

    if (process.env.MONKEY_SKIP_MONEY_FLOW === "1") {
      const reason = process.env.MONKEY_EXPECTED_REASON;
      expect(reason && reason.trim().length >= 12, "MONKEY_SKIP_MONEY_FLOW requires MONKEY_EXPECTED_REASON").toBeTruthy();
      test.skip(true, reason);
    }

    expect(customerState, "Money flow requires deterministic customer storage state.").toBeTruthy();
    const flow = validateMoneyFlowConfig(process.env);
    await page.goto(flow.route);
    await page.locator(flow.addToCart).first().click();
    await page.locator(flow.checkout).first().click();
    await expect(page.locator(flow.paymentShell).first()).toBeVisible();
    await expect(page.locator(flow.sandboxIndicator).first()).toBeVisible();
    await page.locator(flow.actionControl).first().click();
    await expect(page.locator(flow.finalState).first()).toBeVisible({ timeout: 20_000 });
  });
});
`;

export function monkeySpec(header: string): string {
  return `${header}${SPEC_PREAMBLE}${embeddedContractSource()}${SPEC_BODY}`;
}

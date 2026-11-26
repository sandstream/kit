/**
 * `kit security routes [--json]`: list the routes to review for IDOR, hidden admin pages and
 * missing rate limits, with the auth guard and rate limiter names seen. An inventory, never a
 * verdict, so it exits 0 whatever it lists. See src/route-inventory.ts.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { sanitizeDisplayText } from "../display-text.js";
import { buildRouteInventory, type RouteEntry, type RouteInventory } from "../route-inventory.js";

const SECURITY_ROUTES_USAGE = "kit security routes [--json]";

const none = `${c.dim}none seen${c.reset}`;

function column(names: string[]): string {
  return names.length ? sanitizeDisplayText(names.join(", ")) : none;
}

function printRoute(r: RouteEntry): void {
  const why = r.classes.join(", ") + (r.aiSdks.length ? ` (${r.aiSdks.join(", ")})` : "");
  console.log(
    `  ${c.bold}${r.method} ${sanitizeDisplayText(r.path)}${c.reset}  ${c.dim}${sanitizeDisplayText(r.file)}:${r.line}  ${r.framework}  [${why}]${c.reset}`,
  );
  console.log(`      auth guard seen:   ${column(r.authGuardSeen)}`);
  console.log(`      rate limiter seen: ${column(r.rateLimiterSeen)}`);
}

function printText(inv: RouteInventory): void {
  console.log(
    `${c.bold}${c.cyan}kit security routes${c.reset}  ${c.dim}inventory, not a verdict${c.reset}`,
  );
  console.log(`${c.dim}${inv.note}${c.reset}`);
  console.log(
    `${inv.routes.length} route(s) listed of ${inv.totalRoutes} found in ${inv.filesRead} source file(s)`,
  );
  for (const r of inv.routes) printRoute(r);
  if (inv.notRead.length) {
    console.log(
      `${c.yellow}Not read (over 1 MB): ${sanitizeDisplayText(inv.notRead.join(", "))}${c.reset}`,
    );
  }
  console.log(`${c.dim}Not covered: ${inv.notCovered.join("; ")}.${c.reset}`);
}

export function cmdSecurityRoutes(argv: readonly string[] = process.argv): boolean {
  const extra = argv.slice(4).filter((a) => a !== "--json");
  if (extra.length) {
    console.error(`${c.red}Usage: ${SECURITY_ROUTES_USAGE}${c.reset}`);
    return false;
  }
  const inv = buildRouteInventory(process.cwd());
  if (hasFlag(argv, "--json")) console.log(JSON.stringify({ ok: true, ...inv }, null, 2));
  else printText(inv);
  return true;
}

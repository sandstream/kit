import type { PublicTables } from "./anon-public-tables.js";
import type { ReadableTable } from "./check-anon-access.js";
import type { SecurityCheckResult } from "./check-security.js";

export const SIGNED_IN_ACCESS_CHECK = "signed-in database access";

export function describeReadableTable(t: ReadableTable): string {
  const cols = t.personalColumns.length
    ? ` (personal columns: ${t.personalColumns.join(", ")})`
    : "";
  return `${t.table}${cols}`;
}

const SIGNED_IN_BASE = { category: "exposure", name: SIGNED_IN_ACCESS_CHECK } as const;
const SIGNED_IN_SUGGESTION =
  "Replace USING (true) on each listed table with a row-scoped condition such as USING (auth.uid() = user_id), or move personal columns to a table each user reads only their own rows of. A table every signed-in user may read on purpose, with no personal-looking column, can be declared under [anon_access.public] in .kit.toml with a reason.";

/** Warn for a table every signed-in user can read; fail high when it has a personal-looking column. */
export function signedInResult(
  all: ReadableTable[],
  count: string,
  declared: PublicTables,
): SecurityCheckResult {
  const accepted = all.filter((t) => !t.personalColumns.length && declared.reasons.has(t.table));
  const open = all.filter((t) => !accepted.includes(t));
  const suffix = accepted.length
    ? ` (${accepted.length} declared public: ${accepted.map((t) => t.table).join(", ")})`
    : "";
  if (open.length === 0) {
    const what = accepted.length ? "no undeclared table" : "no table";
    return {
      ...SIGNED_IN_BASE,
      status: "pass",
      detail: `${what} is readable in full by every signed-in user in ${count}${suffix}`,
    };
  }
  const personal = open.some((t) => t.personalColumns.length > 0);
  return {
    ...SIGNED_IN_BASE,
    status: personal ? "fail" : "warn",
    severity: personal ? "high" : "medium",
    hasFindings: true,
    detail: `every signed-in user can read every row of ${open.length} table(s) in ${count}: ${open.map(describeReadableTable).join("; ")}${suffix}`,
    suggestion: SIGNED_IN_SUGGESTION,
  };
}

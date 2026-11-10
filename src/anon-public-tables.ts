/** Read `[anon_access.public]` from .kit.toml for the anonymous database access check. */
import { resolve } from "node:path";

/** `[anon_access.public]`: tables a repo serves to anon on purpose, each with a reason. */
export interface PublicTables {
  reasons: Map<string, string>;
  /** Declared tables with an empty reason. They are reported and not applied. */
  noReason: string[];
}

/** `norm` turns a declared name into the form the SQL analysis uses, such as `public.t` into `t`. */
export async function loadPublicTables(
  root: string,
  norm: (table: string) => string,
): Promise<PublicTables> {
  const empty: PublicTables = { reasons: new Map(), noReason: [] };
  let declared: Record<string, string> | undefined;
  try {
    const { loadConfig } = await import("./config.js");
    declared = (await loadConfig(resolve(root, ".kit.toml"))).anon_access?.public;
  } catch {
    return empty; // no .kit.toml, or one that other checks already report
  }
  for (const [table, reason] of Object.entries(declared ?? {})) {
    if (reason.trim()) empty.reasons.set(norm(table), reason.trim());
    else empty.noReason.push(table);
  }
  return empty;
}

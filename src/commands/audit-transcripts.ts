// `kit audit transcripts --identity`: which agent tool calls carried the user's own identities,
// and which of them were network-shaped. Offline and read-only; prints counts, never a value.
import { homedir } from "node:os";
import {
  identitySet,
  scanTranscriptIdentity,
  transcriptRoots,
  type IdentityScan,
} from "../transcript-identity.js";
import { sanitizeDisplayText } from "../display-text.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";

interface Where {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

const USAGE = "usage: kit audit transcripts --identity [--json] [--fail-on-network]";

function rows(map: Record<string, { hits: number; network: number } | number>): string[] {
  return Object.entries(map)
    .map(([key, v]) => ({ key, hits: typeof v === "number" ? v : v.hits, v }))
    .sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key))
    .map(({ key, hits, v }) => {
      const net = typeof v === "number" ? "" : ` (${v.network} network-shaped)`;
      return `  ${sanitizeDisplayText(key).padEnd(28)} ${hits}${net}`;
    });
}

function printScan(scan: IdentityScan): void {
  console.log(`${c.bold}${c.cyan}kit audit transcripts --identity${c.reset}`);
  const kinds = scan.identities.length > 0 ? scan.identities.join(", ") : "none found";
  console.log(`${c.dim}Identities looked for: ${kinds} (values are never printed)${c.reset}`);
  const cap = scan.fileCapReached ? ", file cap reached" : "";
  console.log(
    `Scanned ${scan.filesScanned} transcript file(s) (${scan.filesSkipped} skipped${cap}), ${scan.toolCalls} tool call(s) with an identity in the line`,
  );
  const colour = scan.networkHits > 0 ? c.yellow : c.green;
  console.log(
    `${colour}${scan.hits} tool call(s) carried an identity; ${scan.networkHits} network-shaped${c.reset}`,
  );
  const sections: [string, Record<string, { hits: number; network: number } | number>][] = [
    ["By identity kind", scan.byKind],
    ["By tool", scan.byTool],
    ["Network-shaped, by destination", scan.byHost],
  ];
  for (const [title, map] of sections) {
    if (Object.keys(map).length === 0) continue;
    console.log(`\n${title}:`);
    for (const line of rows(map)) console.log(line);
  }
}

/** `kit audit transcripts`; `args` start after `audit`. False on a usage error or a gated hit. */
export async function cmdAuditTranscripts(
  args: readonly string[] = process.argv.slice(3),
  where: Where = { cwd: process.cwd(), home: homedir(), env: process.env },
): Promise<boolean> {
  if (!hasFlag(args, "--identity")) {
    console.error(USAGE);
    return false;
  }
  const ids = await identitySet(where.cwd, where.home, where.env);
  const scan = await scanTranscriptIdentity(ids, transcriptRoots(where.home, where.env));
  if (hasFlag(args, "--json")) console.log(JSON.stringify(scan, null, 2));
  else printScan(scan);
  return !(hasFlag(args, "--fail-on-network") && scan.networkHits > 0);
}

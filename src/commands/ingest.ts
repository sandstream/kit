import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ingestStrict } from "../adapters/ingest.js";
import { sanitizeDisplayText } from "../display-text.js";
import { c } from "../utils/colors.js";
import { GLOBAL_FLAGS, hasFlag } from "../utils/flags.js";

function ingestArguments(args: string[]): { jsonMode: boolean; positional: string[] } {
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const jsonMode = hasFlag(options, "--json");
  const positional: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const token = options[i];
    if (token === "--env") {
      i++;
    } else if (
      token === "--json" ||
      GLOBAL_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`))
    ) {
      continue;
    } else if (token.startsWith("-")) {
      return { jsonMode, positional: [] };
    } else {
      positional.push(token);
    }
  }
  if (separator >= 0) positional.push(...args.slice(separator + 1));
  return { jsonMode, positional };
}

/** Read a scanner report without storage, scanner execution, or network access. */
export async function cmdIngest(): Promise<boolean> {
  const { jsonMode, positional } = ingestArguments(process.argv.slice(3));
  const fail = (error: string): false => {
    if (jsonMode) console.log(JSON.stringify({ ok: false, error }));
    console.error(`${c.red}${error}${c.reset}`);
    return false;
  };
  const usage = "usage: kit ingest <sarif|osv> <file> [--json]";
  const [format, file] = positional;
  if (positional.length !== 2 || (format !== "sarif" && format !== "osv")) return fail(usage);

  let json: string;
  try {
    json = readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    return fail("could not read report file; check its path and read permissions");
  }
  const outcome = ingestStrict(format, json);
  if (!outcome.ok) return fail(outcome.reason);
  // Report identities stay raw in the parsers. Only the CLI display is sanitized.
  const findings = outcome.findings.map((finding) => ({
    ...finding,
    name: sanitizeDisplayText(finding.name),
    detail: sanitizeDisplayText(finding.detail),
  }));
  console.error("External scanner report. Findings do not verify the current account state.");

  if (jsonMode) {
    console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
    return true;
  }
  console.log(
    `${c.bold}kit ingest${c.reset}  ${c.dim}${format} · ${findings.length} finding(s)${c.reset}`,
  );
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...findings].sort(
    (a, b) => (order[a.severity ?? "low"] ?? 9) - (order[b.severity ?? "low"] ?? 9),
  );
  for (const finding of sorted) {
    const severity = finding.severity ?? "low";
    const color =
      severity === "critical" || severity === "high"
        ? c.red
        : severity === "medium"
          ? c.yellow
          : c.dim;
    const citation = finding.rule ? ` ${c.dim}[${finding.rule.id}]${c.reset}` : "";
    console.log(
      `  ${color}${severity.toUpperCase().padEnd(8)}${c.reset} ${finding.name}${citation}`,
    );
    console.log(`    ${c.dim}${finding.detail}${c.reset}`);
  }
  return true;
}

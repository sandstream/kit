import { parseArgs } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { palConfigure, type VerifyCheck } from "../memory/pal.js";
import { sanitizeForPrompt } from "../memory/injection.js";
import { assertUniquePalOptions, PAL_COMMON_OPTIONS } from "./memory-pal-claims.js";

const USAGE =
  "usage: kit memory pal configure <id> (--manual | --verify-file <path> | --verify-http <url> [--expect <code>])";

function configurationArgs() {
  const { values, positionals, tokens } = parseArgs({
    args: process.argv.slice(5),
    allowPositionals: true,
    tokens: true,
    options: {
      manual: { type: "boolean" },
      "verify-file": { type: "string" },
      "verify-http": { type: "string" },
      expect: { type: "string" },
      ...PAL_COMMON_OPTIONS,
    },
  });
  assertUniquePalOptions(tokens);
  const modes = [values.manual, values["verify-file"], values["verify-http"]];
  if (
    positionals.length !== 1 ||
    !positionals[0] ||
    modes.filter((value) => value !== undefined).length !== 1 ||
    (values.expect !== undefined && values["verify-http"] === undefined)
  )
    throw new RangeError(USAGE);
  const file = values["verify-file"];
  const check: VerifyCheck | null = values.manual
    ? null
    : file !== undefined
      ? { type: "file-exists", path: file }
      : { type: "http-status", url: values["verify-http"]!, expect: Number(values.expect ?? 200) };
  return { id: positionals[0], check };
}

export function memPalConfigure(db: DatabaseSync, jsonMode: boolean): boolean {
  try {
    const { id, check } = configurationArgs();
    const changed = palConfigure(db, id, check);
    const displayId = sanitizeForPrompt(id).text.replace(/\s+/g, " ");
    if (!changed) {
      if (jsonMode) console.log(JSON.stringify({ id, error: "not-found" }));
      else console.error(`${displayId}: requires an existing action item`);
    } else if (jsonMode) console.log(JSON.stringify({ id, kind: check ? "auto" : "manual" }));
    else console.log(`configured ${displayId}: ${check ? "auto" : "manual"}`);
    return changed;
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
    throw Object.assign(new Error(USAGE), { code: "KIT_USAGE_ERROR" });
  }
}

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { getMemoryDbPath, openMemoryDb } from "../memory/db.js";
import {
  deviceId,
  palClaim,
  palRenew,
  palTakeover,
  palDone,
  palSnooze,
  palRelease,
  palReopen,
  type PalClaimOwner,
} from "../memory/pal.js";
import { PalStateError, type PalView, type PalWriteOptions } from "../memory/pal-revisions.js";
import { sanitizeForPrompt } from "../memory/injection.js";

export const PAL_COMMON_OPTIONS = {
  json: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  "read-only": { type: "boolean" },
  readonly: { type: "boolean" },
  env: { type: "string" },
  help: { type: "boolean" },
  version: { type: "boolean" },
} as const;

export const PAL_OWNER_OPTIONS = {
  harness: { type: "string" },
  session: { type: "string" },
} as const;

export function palDisplay(value: string): string {
  return sanitizeForPrompt(value).text.replace(/\s+/g, " ");
}

export function assertUniquePalOptions(tokens: readonly { kind: string; name?: string }[]): void {
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || !token.name) continue;
    if (seen.has(token.name)) throw new RangeError(`Repeated --${token.name}`);
    seen.add(token.name);
  }
}

export function palOwnerArguments(values: {
  harness?: string;
  session?: string;
}): PalClaimOwner | undefined {
  if (values.harness === undefined && values.session === undefined) return undefined;
  if (
    [values.harness, values.session].some(
      (part) =>
        part === undefined ||
        !part.trim() ||
        part.trim() !== part ||
        part.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(part),
    )
  )
    throw new RangeError("Provide both --harness <name> and --session <id>");
  return { device: deviceId(), harness: values.harness!, session: values.session! };
}

export function renderPalFailure(
  error: unknown,
  jsonMode: boolean,
  id: string | undefined,
  usage: string,
): false {
  const invalid =
    error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError;
  if (invalid) throw Object.assign(new Error(usage), { code: "KIT_USAGE_ERROR" });
  const message = error instanceof Error ? error.message : "Pending action unavailable";
  const status = error instanceof PalStateError ? error.code : "unavailable";
  if (jsonMode) console.log(JSON.stringify({ id, status, error: message }));
  if (!jsonMode) console.error(palDisplay(message));
  return false;
}

export function renderPalReceipt(view: PalView): void {
  console.log(`frontier: ${view.frontier}`);
  for (const { id, state } of view.heads) {
    if (state.status !== "claimed") continue;
    const owner = state.claim_owner;
    console.log(
      palDisplay(
        owner
          ? `owner (${id}): device=${owner.device}; harness=${owner.harness}; session=${owner.session}`
          : `owner (${id}): unknown legacy session; explicit takeover required`,
      ),
    );
  }
}

type ClaimAction = "claim" | "renew" | "takeover";

function claimArguments(action: ClaimAction) {
  const { positionals, values, tokens } = parseArgs({
    args: process.argv.slice(5),
    allowPositionals: true,
    tokens: true,
    options: {
      expect: { type: "string" },
      ...(action === "takeover" ? { take: { type: "string" as const } } : {}),
      ...PAL_OWNER_OPTIONS,
      ...PAL_COMMON_OPTIONS,
    },
  });
  assertUniquePalOptions(tokens);
  const take = values.take;
  if (
    take !== undefined &&
    (typeof take !== "string" || !/^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(take))
  )
    throw new RangeError();
  if (
    !positionals[0]?.trim() ||
    positionals.length > (action === "renew" ? 1 : 2) ||
    (positionals[1] !== undefined && !positionals[1].trim()) ||
    !/^[a-f0-9]{64}$/.test(values.expect ?? "") ||
    values.harness === undefined ||
    values.session === undefined
  )
    throw new RangeError();
  return {
    id: positionals[0],
    label: positionals[1],
    take,
    owner: palOwnerArguments(values)!,
    expectedFrontier: values.expect!,
  };
}

export function memPalClaim(action: ClaimAction, jsonMode: boolean): boolean {
  const usage = `usage: kit memory pal ${action} <id>${action === "renew" ? "" : " [label]"} --harness <name> --session <id> --expect <frontier>${action === "takeover" ? " [--take <head>] (required for multiple heads)" : ""}`;
  let db: ReturnType<typeof openMemoryDb> | undefined;
  let id: string | undefined;
  try {
    const args = claimArguments(action);
    id = args.id;
    if (existsSync(getMemoryDbPath())) db = openMemoryDb();
    const operation = { claim: palClaim, renew: palRenew, takeover: palTakeover }[action];
    const result = db ? operation(db, id, args) : { status: "missing" as const };
    if (jsonMode) console.log(JSON.stringify({ id, ...result }));
    else {
      console.log(`${palDisplay(id)}: ${result.status}`);
      if (result.view) renderPalReceipt(result.view);
    }
    return result.status === "applied";
  } catch (error) {
    return renderPalFailure(error, jsonMode, id, usage);
  } finally {
    db?.close();
  }
}

function transitionArguments(action: string) {
  const { positionals, values, tokens } = parseArgs({
    args: process.argv.slice(5),
    allowPositionals: true,
    tokens: true,
    options: { expect: { type: "string" }, ...PAL_OWNER_OPTIONS, ...PAL_COMMON_OPTIONS },
  });
  assertUniquePalOptions(tokens);
  const days = Number(positionals[1] ?? "7");
  if (
    !positionals[0]?.trim() ||
    positionals.length > (action === "snooze" ? 2 : 1) ||
    (values.expect !== undefined && !/^[a-f0-9]{64}$/.test(values.expect)) ||
    (action === "snooze" && (!Number.isSafeInteger(days) || days < 1))
  )
    throw new RangeError();
  return {
    id: positionals[0],
    days,
    owner: palOwnerArguments(values),
    expectedFrontier: values.expect,
  };
}

export function memPalTransition(action: string, jsonMode: boolean): boolean | undefined {
  const operations: Record<
    string,
    (
      db: ReturnType<typeof openMemoryDb>,
      id: string,
      days: number,
      opts: PalWriteOptions,
    ) => boolean
  > = {
    done: (db, id, _, opts) => palDone(db, id, opts),
    snooze: (db, id, days, opts) => palSnooze(db, id, days, opts),
    release: (db, id, _, opts) => palRelease(db, id, opts),
    reopen: (db, id, _, opts) => palReopen(db, id, opts),
  };
  if (!Object.hasOwn(operations, action)) return undefined;
  const usage = `usage: kit memory pal ${action} <id>${action === "snooze" ? " [days]" : ""} [--expect <frontier>] [--harness <name> --session <id>]`;
  let db: ReturnType<typeof openMemoryDb> | undefined;
  let id: string | undefined;
  try {
    const args = transitionArguments(action);
    id = args.id;
    if (existsSync(getMemoryDbPath())) db = openMemoryDb();
    const changed = db ? operations[action](db, id, args.days, args) : false;
    const status = !db ? "missing" : changed ? "applied" : "unchanged";
    if (jsonMode) console.log(JSON.stringify({ id, status }));
    else console.log(`${palDisplay(id)}: ${status}`);
    return changed;
  } catch (error) {
    return renderPalFailure(error, jsonMode, id, usage);
  } finally {
    db?.close();
  }
}

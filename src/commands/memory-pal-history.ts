import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getMemoryDbPath, openMemoryDb, openMemoryDbReadOnly } from "../memory/db.js";
import { palForget, palResolve, palShow } from "../memory/pal.js";
import type { PalView } from "../memory/pal-revisions.js";
import {
  PAL_COMMON_OPTIONS,
  PAL_OWNER_OPTIONS,
  assertUniquePalOptions,
  palOwnerArguments,
  palDisplay as display,
  renderPalFailure,
  renderPalReceipt,
} from "./memory-pal-claims.js";
const RESOLVE_USAGE =
  "usage: kit memory pal resolve <id> --expect <frontier> (--take <revision> | --state <file>) [--harness <name> --session <id>]";
const SHOW_USAGE = "usage: kit memory pal show <id> [--history] [--json]";
const FORGET_USAGE =
  "usage: kit memory pal forget <id> --expect <frontier> [--harness <name> --session <id>] [--json]";

function forgetArgs() {
  const { positionals, values, tokens } = parseArgs({
    args: process.argv.slice(5),
    allowPositionals: true,
    tokens: true,
    options: { expect: { type: "string" }, ...PAL_OWNER_OPTIONS, ...PAL_COMMON_OPTIONS },
  });
  assertUniquePalOptions(tokens);
  if (
    positionals.length !== 1 ||
    !positionals[0]?.trim() ||
    !/^[a-f0-9]{64}$/.test(values.expect ?? "")
  )
    throw new RangeError(FORGET_USAGE);
  return { id: positionals[0], expectedFrontier: values.expect!, owner: palOwnerArguments(values) };
}

export function memPalForget(jsonMode: boolean): boolean {
  let db: ReturnType<typeof openMemoryDb> | undefined;
  let id: string | undefined;
  try {
    const args = forgetArgs();
    id = args.id;
    if (existsSync(getMemoryDbPath())) db = openMemoryDb();
    const result = db ? palForget(db, id, args) : { status: "missing" as const };
    if (jsonMode) console.log(JSON.stringify({ id, ...result }));
    else console.log(`${display(id)}: ${result.status}`);
    return result.status === "applied";
  } catch (error) {
    return renderPalFailure(error, jsonMode, id, FORGET_USAGE);
  } finally {
    db?.close();
  }
}

function resolutionArgs() {
  const { positionals, values, tokens } = parseArgs({
    args: process.argv.slice(5),
    allowPositionals: true,
    tokens: true,
    options: {
      expect: { type: "string" },
      take: { type: "string" },
      state: { type: "string" },
      ...PAL_OWNER_OPTIONS,
      ...PAL_COMMON_OPTIONS,
    },
  });
  assertUniquePalOptions(tokens);
  const id = positionals[0];
  if (
    !id?.trim() ||
    positionals.length !== 1 ||
    !/^[a-f0-9]{64}$/.test(values.expect ?? "") ||
    Number(values.take !== undefined) + Number(values.state !== undefined) !== 1 ||
    (values.take !== undefined && !/^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(values.take)) ||
    (values.state !== undefined && !values.state.trim())
  )
    throw new RangeError(RESOLVE_USAGE);
  const owner = palOwnerArguments(values);
  const choice =
    values.take !== undefined
      ? { revision: values.take }
      : { state: JSON.parse(readFileSync(values.state!, "utf8")) };
  return { id, expectedFrontier: values.expect!, choice, owner };
}

/** --expect is a causal frontier here, not the HTTP status used by configure. */
export function memPalResolve(jsonMode: boolean): boolean {
  let db: ReturnType<typeof openMemoryDb> | undefined;
  let id: string | undefined;
  try {
    const args = resolutionArgs();
    id = args.id;
    if (existsSync(getMemoryDbPath())) db = openMemoryDb();
    const result = db ? palResolve(db, id, args) : { status: "missing" as const };
    if (jsonMode) console.log(JSON.stringify({ id, ...result }));
    else {
      console.log(`${display(id)}: ${result.status}`);
      if (result.view) renderPalReceipt(result.view);
    }
    return result.status === "applied";
  } catch (error) {
    return renderPalFailure(error, jsonMode, id, RESOLVE_USAGE);
  } finally {
    db?.close();
  }
}

function inspectionArgs() {
  const parsed = parseArgs({
    args: process.argv.slice(5),
    allowPositionals: true,
    tokens: true,
    options: {
      history: { type: "boolean" },
      ...PAL_COMMON_OPTIONS,
    },
  });
  assertUniquePalOptions(parsed.tokens);
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]?.trim()) throw new RangeError();
  return { id: parsed.positionals[0], history: parsed.values.history ?? false };
}

function renderView(view: PalView): void {
  console.log(`${display(view.id)}: ${view.conflict ? "unresolved conflict" : "current"}`);
  renderPalReceipt(view);
  for (const revision of view.history ?? view.heads) {
    console.log(display(`${revision.id} ${revision.state.status}: ${revision.state.title}`));
    console.log(
      display(
        `  device: ${revision.actorDevice ?? "legacy observation"}; parents: ${revision.parents.join(", ") || "none"}`,
      ),
    );
  }
}

export function memPalShow(jsonMode: boolean): boolean {
  let db: ReturnType<typeof openMemoryDbReadOnly> | undefined;
  let id: string | undefined;
  try {
    const args = inspectionArgs();
    id = args.id;
    const history = args.history;
    if (existsSync(getMemoryDbPath())) db = openMemoryDbReadOnly();
    const view = db ? palShow(db, id, { history }) : null;
    if (!view) {
      if (jsonMode) console.log(JSON.stringify({ id, status: "missing" }));
      else console.error(`${display(id)}: pending action not found`);
      return false;
    }
    if (jsonMode) console.log(JSON.stringify(view));
    else renderView(view);
    return true;
  } catch (error) {
    return renderPalFailure(error, jsonMode, id, SHOW_USAGE);
  } finally {
    db?.close();
  }
}

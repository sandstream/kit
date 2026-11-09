import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isReadOnlyMode } from "./read-only-mode.js";
import { sameIdentity } from "./utils/same-file.js";

export const BUDGET_STATE_FILE = ".kit-budget.json";
export const BUDGET_STATE_ERROR = "Could not read budget usage. Check .kit-budget.json.";

export interface BudgetState {
  generation?: string;
  tokens_today: number;
  operations_this_hour: number;
  last_token_reset: string;
  last_operation_reset: string;
}

function isResetTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  // Stored timestamps use the UTC format produced by Date.toISOString().
  return (
    Number.isFinite(date.getTime()) && date.getTime() <= Date.now() && date.toISOString() === value
  );
}

function isBudgetState(value: unknown): value is BudgetState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    (state.generation === undefined ||
      (typeof state.generation === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          state.generation,
        ))) &&
    typeof state.tokens_today === "number" &&
    Number.isFinite(state.tokens_today) &&
    state.tokens_today >= 0 &&
    typeof state.operations_this_hour === "number" &&
    Number.isSafeInteger(state.operations_this_hour) &&
    state.operations_this_hour >= 0 &&
    isResetTimestamp(state.last_token_reset) &&
    isResetTimestamp(state.last_operation_reset)
  );
}

async function stateExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid budget state file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertStateFile(file: FileHandle, allowRemovedSnapshot = false): Promise<void> {
  const stat = await file.stat();
  const allowedLinks = stat.nlink === 1 || (allowRemovedSnapshot && stat.nlink === 0);
  if (!stat.isFile() || !allowedLinks) throw new Error("Invalid budget state file");
}

/** Read and validate stored usage. Only an absent path starts with zero usage. */
export async function loadBudgetState(cwd = process.cwd()): Promise<BudgetState> {
  const path = resolve(cwd, BUDGET_STATE_FILE);
  try {
    if (!(await stateExists(path))) {
      const now = new Date().toISOString();
      return {
        tokens_today: 0,
        operations_this_hour: 0,
        last_token_reset: now,
        last_operation_reset: now,
      };
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      // Atomic replacement can unlink this already opened, complete read snapshot.
      await assertStateFile(file, true);
      const state: unknown = JSON.parse(await file.readFile("utf8"));
      if (!isBudgetState(state)) throw new Error("Invalid budget state");
      return state;
    } finally {
      await file.close();
    }
  } catch {
    // Never include parser messages, source text, or filesystem paths in errors.
    throw new Error(BUDGET_STATE_ERROR);
  }
}

async function writableState(path: string): Promise<FileHandle | undefined> {
  if (!(await stateExists(path))) return undefined;
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await assertStateFile(file);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function unchangedDestination(path: string, previous?: BigIntStats): Promise<void> {
  let current: BigIntStats | undefined;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!previous && !current) return;
  if (!sameIdentity(previous, current) || !current?.isFile() || current.nlink !== 1n) {
    throw new Error("Budget state changed during replacement");
  }
  if (previous!.mtimeNs !== current.mtimeNs || previous!.size !== current.size) {
    throw new Error("Budget state changed during replacement");
  }
}

async function replaceState(
  path: string,
  state: BudgetState,
  previous?: BigIntStats,
): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const file = await open(temporary, flags, 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(state, null, 2), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await unchangedDestination(path, previous);
    await fs.rename(temporary, path);
  } catch (writeError) {
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([writeError, cleanupError], "Could not replace budget state", {
          cause: cleanupError,
        });
      }
    }
    throw writeError;
  }
}

/** Replace complete usage atomically. Callers serialize mutations with the budget lock. */
export async function saveBudgetState(state: BudgetState, cwd: string): Promise<void> {
  if (isReadOnlyMode()) return;
  const path = resolve(cwd, BUDGET_STATE_FILE);
  let previous: FileHandle | undefined;
  try {
    if (!isBudgetState(state)) throw new Error("Invalid budget state");
    await mkdir(dirname(path), { recursive: true });
    previous = await writableState(path);
    const stat = await previous?.stat({ bigint: true });
    await replaceState(path, state, stat);
  } catch {
    throw new Error("Could not save budget usage. Check .kit-budget.json.");
  } finally {
    await previous?.close();
  }
}

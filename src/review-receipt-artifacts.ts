/** Explain recovery artifacts without moving or deleting user data. */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HISTORY_TEMP = /^\.kit-receipt-[a-f0-9]{32}\.tmp$/;
const RECEIPT_TEMP = /^\.kit-review-receipt\.json\.[a-f0-9]{12}\.tmp$/;

function describeHistoryLink(root: string, temp: string): string | null {
  const history = join(root, ".kit-review-receipt-history.jsonl");
  let current;
  let staged;
  try {
    current = lstatSync(history, { bigint: true });
    staged = lstatSync(temp, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !current.isFile() ||
    !staged.isFile() ||
    current.ino === 0n ||
    current.dev !== staged.dev ||
    current.ino !== staged.ino ||
    current.nlink !== 2n ||
    staged.nlink !== 2n ||
    current.size !== 0n
  )
    return null;
  return `The history file ${history} and temporary file ${temp} are two links to the same empty file. This does not prove who owns the temporary name. Preserve both files, inspect the Git index and signed pending evidence, and confirm the review stopped. Only a qualified person who establishes ownership may remove the temporary name before retrying recovery.`;
}

export function assertNoRecoveryArtifacts(root: string, lockDir: string): void {
  const names = readdirSync(root).filter(
    (name) => HISTORY_TEMP.test(name) || RECEIPT_TEMP.test(name),
  );
  if (names.length === 0) return;
  const paths = names.sort().map((name) => join(root, name));
  const detail =
    names.length === 1 && HISTORY_TEMP.test(names[0]!)
      ? describeHistoryLink(root, paths[0]!)
      : null;
  throw new Error(
    detail ??
      `Recovery found temporary receipt files: ${paths.join(", ")}. Preserve these files and the signed pending evidence in ${lockDir}. After confirming the review stopped, inspect the files and move only verified temporary artifacts outside the worktree before retrying recovery.`,
  );
}

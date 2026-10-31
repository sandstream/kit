/** Validate the worktree before receipt creation, recovery, or verification. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_RECEIPT_HISTORY_FILE } from "./review-receipt-history-io.js";
import type { ReadCommand } from "./review-receipt-io.js";

export const REVIEW_RECEIPT_FILE = ".kit-review-receipt.json";

export function cleanReviewWorktree(root: string, run: ReadCommand): void {
  const outputFiles = [REVIEW_RECEIPT_FILE, REVIEW_RECEIPT_HISTORY_FILE];
  const indexedPaths = outputFiles.map((file) => `:(icase,literal)${file}`);
  if (run("git", ["ls-files", "-z", "--", ...indexedPaths], root) !== "") {
    throw new Error("review receipt output paths must not contain tracked files");
  }
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], root);
  const dirty = status
    .split("\n")
    .some((line) => line !== "" && !outputFiles.some((file) => line === `?? ${file}`));
  if (dirty) {
    throw new Error("review receipt requires a clean worktree");
  }
  for (const file of outputFiles) {
    let stat;
    try {
      stat = lstatSync(join(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("review receipt output must be a regular file without hard links");
    }
  }
}

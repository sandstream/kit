/** Refuse review file mutations when read-only mode is active. */
import { isReadOnlyMode, refuseWrite } from "./read-only-mode.js";

export class ReviewReadOnlyRefusal extends Error {
  readonly audit: Promise<unknown>;

  constructor(operation: string, cwd: string) {
    super(`read-only mode active, refusing "${operation}"`);
    this.audit = refuseWrite(operation, {}, { cwd });
  }
}

export function assertReviewWritable(cwd: string, operation = "review-receipt"): void {
  if (isReadOnlyMode()) throw new ReviewReadOnlyRefusal(operation, cwd);
}

export async function withReviewWrite<T>(
  cwd: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    assertReviewWritable(cwd, operation);
    return await action();
  } catch (error) {
    if (error instanceof ReviewReadOnlyRefusal) await error.audit;
    else if (isReadOnlyMode()) {
      const refusal = new ReviewReadOnlyRefusal(operation, cwd);
      await refusal.audit;
      throw refusal;
    }
    throw error;
  }
}

import { withSqliteMutex } from "./sqlite-mutex.js";
import { canonicalAuditLogPath } from "./audit-log-path.js";

/** Serialize the chain write and anchor advance under the same canonical log path. */
export async function withAuditWriteLock<T>(
  path: string,
  operation: (canonical: string) => Promise<T>,
): Promise<T> {
  const canonical = canonicalAuditLogPath(path);
  return withSqliteMutex(`${canonical}.lock.sqlite`, () => operation(canonical));
}

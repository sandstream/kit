import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  privateDirIsControlled,
  privateFileIsControlled,
  secureDirStrict,
  secureFileStrict,
} from "../utils/secure-perms.js";
import { deviceId } from "./device.js";

interface GrantTarget {
  sync_id?: string | null;
  origin_root: string | null;
  verify_check: string | null;
  verify_grant?: string | null;
}

const transient = new WeakMap<DatabaseSync, Map<string, string>>();
const TOKEN = /^[a-f0-9]{32}$/;

function locallyControlled(
  path: string,
  kind: "file" | "dir",
  info: { mode: number | bigint; uid: number | bigint },
): boolean {
  if (process.platform === "win32")
    return kind === "file" ? privateFileIsControlled(path) : privateDirIsControlled(path);
  const uid = process.getuid?.();
  return (
    (BigInt(info.mode) & 0o022n) === 0n && (uid === undefined || BigInt(info.uid) === BigInt(uid))
  );
}

function localContext(db: DatabaseSync, persistDevice = false, establishAuthority = false) {
  const databases = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
  const file = databases.find(({ name }) => name === "main")?.file;
  if (file === undefined) throw new Error("Memory database is unavailable");
  const device = deviceId({ persist: persistDevice });
  if (!file) return { binding: ["transient", device], directory: null };
  const path = realpathSync(file);
  if (establishAuthority) secureFileStrict(path);
  const info = statSync(path, { bigint: true });
  if (!info.isFile() || info.ino === 0n || !locallyControlled(path, "file", info))
    throw new Error("Cannot establish local memory database identity");
  const binding = [path, String(info.dev), String(info.ino), String(info.birthtimeNs), device];
  return {
    binding,
    directory: join(dirname(path), ".kit-verifier-grants"),
    namespace: createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
  };
}

function fingerprint(target: GrantTarget, binding: string[]): string {
  if (!target.sync_id || !target.verify_check) throw new Error("Verification target is incomplete");
  const check = JSON.parse(target.verify_check);
  const root =
    check?.type === "file-exists" && typeof check.path === "string" && !isAbsolute(check.path)
      ? target.origin_root
      : null;
  return createHash("sha256")
    .update(JSON.stringify([target.sync_id, root, target.verify_check, binding]))
    .digest("hex");
}

function transientGrants(db: DatabaseSync): Map<string, string> {
  let grants = transient.get(db);
  if (!grants) {
    grants = new Map();
    transient.set(db, grants);
  }
  return grants;
}

/** Approval markers are local files, never part of the portable SQLite snapshot. */
export function createActionGrant(db: DatabaseSync, target: GrantTarget): string {
  const context = localContext(db, true, true);
  const token = randomBytes(16).toString("hex");
  const approved = fingerprint(target, context.binding);
  if (!context.directory) {
    transientGrants(db).set(token, approved);
    return token;
  }
  mkdirSync(context.directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(context.directory).isDirectory())
    throw new Error("Local verifier grants must use a private directory, not a link");
  secureDirStrict(context.directory);
  const path = join(context.directory, `${context.namespace}-${token}`);
  const fd = openSync(path, "wx", 0o600);
  let complete = false;
  try {
    writeFileSync(fd, approved);
    secureFileStrict(path);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) rmSync(path, { force: true });
  }
  return token;
}

export function actionCheckIsAuthorized(db: DatabaseSync, target: GrantTarget): boolean {
  if (!target.verify_grant || !TOKEN.test(target.verify_grant)) return false;
  try {
    const context = localContext(db);
    const expected = fingerprint(target, context.binding);
    if (!context.directory) return transientGrants(db).get(target.verify_grant) === expected;
    const directory = lstatSync(context.directory);
    if (!directory.isDirectory() || !locallyControlled(context.directory, "dir", directory))
      return false;
    const path = join(context.directory, `${context.namespace}-${target.verify_grant}`);
    const info = lstatSync(path);
    return (
      info.isFile() &&
      locallyControlled(path, "file", info) &&
      info.size === 64 &&
      readFileSync(path, "utf8") === expected
    );
  } catch {
    return false;
  }
}

/** Cleanup may leave an orphan marker; it cannot authorize the current row after replacement. */
export function removeActionGrant(db: DatabaseSync, token: string | null | undefined): void {
  if (!token || !TOKEN.test(token)) return;
  try {
    const context = localContext(db);
    if (!context.directory) transientGrants(db).delete(token);
    else if (lstatSync(context.directory).isDirectory())
      rmSync(join(context.directory, `${context.namespace}-${token}`), { force: true });
  } catch {
    // Missing or inaccessible obsolete markers must not undo an applied configuration.
  }
}

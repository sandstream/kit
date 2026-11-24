import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { sameIdentity } from "./utils/same-file.js";

type RenameFile = (from: string, to: string) => void;

export interface ApplySignedPairResult {
  ok: boolean;
  detail: string;
}

type SignatureSnapshot =
  { kind: "file"; bytes: Buffer; mode: number } | { kind: "symlink"; target: string };

export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "filesystem error";
}

function readSignatureSnapshot(path: string): SignatureSnapshot | null {
  // A symlink target can only be read by path in portable Node. Read it before
  // checking the entry, so no later path read follows a checked symlink.
  let linkTarget: string | null = null;
  try {
    linkTarget = readlinkSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) !== "EINVAL") throw error;
  }
  if (linkTarget !== null) {
    const info = lstatSync(path);
    if (!info.isSymbolicLink()) {
      throw Object.assign(new Error("signature changed during snapshot"), { code: "EAGAIN" });
    }
    return { kind: "symlink", target: linkTarget };
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile())
      throw Object.assign(new Error("signature is not a regular file"), { code: "EINVAL" });
    const bytes = readFileSync(fd);
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || !sameIdentity(opened, entry)) {
      throw Object.assign(new Error("signature changed during snapshot"), { code: "EAGAIN" });
    }
    return { kind: "file", bytes, mode: Number(opened.mode) };
  } finally {
    closeSync(fd);
  }
}

function restoreSignature(
  path: string,
  snapshot: SignatureSnapshot | null,
  kind: SignedPairKind,
): void {
  if (snapshot === null) {
    rmSync(path, { force: true });
    return;
  }
  const stage = mkdtempSync(join(dirname(path), `.kit-${kind}-restore-`));
  try {
    const replacement = join(stage, "signature");
    if (snapshot.kind === "symlink") {
      symlinkSync(snapshot.target, replacement);
    } else {
      writeFileSync(replacement, snapshot.bytes, { mode: snapshot.mode });
      chmodSync(replacement, snapshot.mode);
    }
    renameSync(replacement, path);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function rollbackSignature(
  path: string,
  snapshot: SignatureSnapshot | null,
  applyError: unknown,
  kind: SignedPairKind,
): ApplySignedPairResult {
  try {
    restoreSignature(path, snapshot, kind);
  } catch (restoreError) {
    return {
      ok: false,
      detail: `apply failed (${errorCode(applyError)}); signature rollback also failed (${errorCode(restoreError)}). The ${kind} remains fail-closed`,
    };
  }
  return {
    ok: false,
    detail: `apply failed (${errorCode(applyError)}); previous pair retained`,
  };
}

type SignedPairKind = "policy" | "profile";

/** Publish the signature first. If the document cannot be published, restore the previous signature. */
export function applySignedPairAtomically(
  target: { document: string; signature: string; kind: SignedPairKind },
  documentBytes: Buffer,
  signatureBytes: Buffer,
  renameFile: RenameFile = renameSync,
): ApplySignedPairResult {
  let stage: string | null = null;
  const { document: destDocument, signature: destSignature, kind } = target;
  let previousSignature: SignatureSnapshot | null = null;
  let signatureReplaced = false;

  try {
    previousSignature = readSignatureSnapshot(destSignature);
    stage = mkdtempSync(join(dirname(destDocument), `.kit-${kind}-apply-`));
    const nextDocument = join(stage, basename(destDocument));
    const nextSignature = join(stage, basename(destSignature));
    writeFileSync(nextDocument, documentBytes);
    writeFileSync(nextSignature, signatureBytes);

    renameFile(nextSignature, destSignature);
    signatureReplaced = true;
    renameFile(nextDocument, destDocument);
    return { ok: true, detail: `verified ${kind} pair installed` };
  } catch (error) {
    if (signatureReplaced) {
      return rollbackSignature(destSignature, previousSignature, error, kind);
    }
    return { ok: false, detail: `apply failed (${errorCode(error)}); previous pair retained` };
  } finally {
    if (stage) {
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch {
        // The applied pair is already complete; stale private staging data is non-authoritative.
      }
    }
  }
}

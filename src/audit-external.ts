import { createHash, randomUUID } from "node:crypto";
import type {
  AnchorRecord,
  ExternalAnchorReceipt,
  ExternalTimestampAnchor,
} from "./audit-anchor.js";
import { canonicalAuditLogPath } from "./audit-log-path.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";

/** The operator's authority must authenticate every field of this statement. */
export interface ExternalAnchorStatement {
  version: 1;
  domain: "kit.audit.external/v1";
  logPath: string;
  count: number;
  tip: string;
  anchorVersion: number;
  algorithm: string;
  keyFingerprint: string | null;
}

export interface ExternalAnchorVerification {
  status: "verified" | "invalid" | "unverified";
  message: string;
  authenticity: "valid" | "invalid" | "unknown";
  rollback: "acceptable" | "stale" | "unknown";
}

export function externalStatement(logPath: string, record: AnchorRecord): ExternalAnchorStatement {
  return {
    version: 1,
    domain: "kit.audit.external/v1",
    logPath,
    count: record.count,
    tip: record.tip,
    anchorVersion: record.version ?? 1,
    algorithm: record.algo,
    keyFingerprint: record.keyFingerprint ?? null,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unknown(message: string): ExternalAnchorVerification {
  return { status: "unverified", message, authenticity: "unknown", rollback: "unknown" };
}

function invalid(message: string): ExternalAnchorVerification {
  return { status: "invalid", message, authenticity: "invalid", rollback: "unknown" };
}

function validStatementSeal(s: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(s.count) &&
    (s.count as number) >= 0 &&
    typeof s.tip === "string" &&
    /^[a-f0-9]{64}$/i.test(s.tip) &&
    Number.isSafeInteger(s.anchorVersion) &&
    (s.anchorVersion as number) >= 1 &&
    s.algorithm === "hmac-sha256" &&
    (s.keyFingerprint === null ||
      (typeof s.keyFingerprint === "string" && /^[a-f0-9]{32}$/i.test(s.keyFingerprint)))
  );
}

export function validExternalStatement(value: unknown): value is ExternalAnchorStatement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === 1 &&
    s.domain === "kit.audit.external/v1" &&
    typeof s.logPath === "string" &&
    s.logPath.length > 0 &&
    validStatementSeal(s)
  );
}

function normalizedStatement(bound: ExternalAnchorStatement): ExternalAnchorStatement {
  return externalStatement(bound.logPath, {
    tip: bound.tip,
    count: bound.count,
    algo: bound.algorithm,
    version: bound.anchorVersion,
    keyFingerprint: bound.keyFingerprint ?? undefined,
    updatedAt: "",
  });
}

/** Stable receipt identity for alias comparison, including the authenticated statement. */
export function externalReceiptIdentity(receipt: ExternalAnchorReceipt | undefined): string {
  if (!receipt) return "";
  return JSON.stringify([
    receipt.token,
    receipt.authority,
    receipt.timestamp,
    receipt.statement ? normalizedStatement(receipt.statement) : null,
  ]);
}

/** Keep the authenticated path spelling only when it still names the inspected file. */
function expectedStatement(logPath: string, record: AnchorRecord): ExternalAnchorStatement | null {
  const bound = record.external?.statement;
  if (!validExternalStatement(bound)) return null;
  const current = canonicalAuditLogPath(logPath);
  const original = canonicalAuditLogPath(bound.logPath);
  if (current !== original && !sameIdentity(identityOf(current), identityOf(original))) return null;
  const expected = externalStatement(bound.logPath, record);
  const normalized = normalizedStatement(bound);
  return digest(expected) === digest(normalized) ? expected : null;
}

function receiptData(receipt: ExternalAnchorReceipt, statement: ExternalAnchorStatement) {
  return {
    token: receipt.token,
    authority: receipt.authority,
    timestamp: receipt.timestamp,
    statement,
  };
}

function verdict(
  response: unknown,
  request: {
    requestId: string;
    statementDigest: string;
    receiptDigest: string;
    receipt: ExternalAnchorReceipt;
  },
): ExternalAnchorVerification {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return unknown("external anchor UNVERIFIED: the verifier response is invalid.");
  }
  const r = response as Record<string, unknown>;
  if (
    r.version !== 1 ||
    r.requestId !== request.requestId ||
    r.statementDigest !== request.statementDigest ||
    r.receiptDigest !== request.receiptDigest
  ) {
    return unknown(
      "external anchor UNVERIFIED: the verifier response does not match this request.",
    );
  }
  if (r.authenticity === "invalid")
    return invalid("external anchor INVALID: the authority rejected the receipt or statement.");
  if (r.authenticity !== "valid")
    return unknown("external anchor UNVERIFIED: authenticity is unknown.");
  if (r.authority !== request.receipt.authority || r.attestedAt !== request.receipt.timestamp) {
    return invalid(
      "external anchor INVALID: the authority or timestamp differs from the authenticated receipt.",
    );
  }
  if (r.rollback === "stale") {
    return {
      status: "invalid",
      message: "external anchor INVALID: the receipt is older than the trusted checkpoint.",
      authenticity: "valid",
      rollback: "stale",
    };
  }
  if (r.rollback !== "acceptable") {
    return {
      ...unknown("external anchor UNVERIFIED: the current trusted checkpoint is unknown."),
      authenticity: "valid",
    };
  }
  return {
    status: "verified",
    message: "External receipt authenticity and current checkpoint verified.",
    authenticity: "valid",
    rollback: "acceptable",
  };
}

/** Read-only verification. Neither an issuer nor a repair path is called here. */
export async function verifyExternalAnchor(
  logPath: string,
  record: AnchorRecord,
): Promise<ExternalAnchorVerification> {
  const receipt = record.external;
  if (!receipt) return unknown("external anchor UNVERIFIED: no receipt exists.");
  if (!receipt.statement)
    return unknown(
      "external anchor UNVERIFIED: the receipt has no authenticated statement binding.",
    );
  const command = (process.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD ?? "").trim();
  if (!command)
    return unknown("external anchor UNVERIFIED: KIT_EXTERNAL_ANCHOR_VERIFY_CMD is not configured.");
  try {
    const statement = expectedStatement(logPath, record);
    if (!statement)
      return invalid(
        "external anchor INVALID: the receipt statement does not match this log and seal.",
      );
    const normalizedReceipt = receiptData(receipt, statement);
    const request = {
      version: 1,
      operation: "verify",
      requestId: randomUUID(),
      statement,
      statementDigest: digest(statement),
      receiptDigest: digest(normalizedReceipt),
      receipt: normalizedReceipt,
    };
    const { runExternalProtocol } = await import("./audit-external-process.js");
    const output = await runExternalProtocol(command, request);
    return verdict(JSON.parse(output), request);
  } catch {
    // The transport and provider may contain secrets. Do not expose their diagnostics.
    return unknown(
      "external anchor UNVERIFIED: the verifier failed, timed out, or returned invalid output.",
    );
  }
}

/** Publish no local receipt until the configured verifier authenticates it. */
export async function issueExternalReceipt(
  logPath: string,
  record: AnchorRecord,
): Promise<ExternalAnchorReceipt> {
  const issuer = resolveExternalAnchor();
  if (!issuer)
    throw new Error(
      "External anchoring requested but none configured. Set KIT_EXTERNAL_ANCHOR_CMD.",
    );
  if (!(process.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD ?? "").trim()) {
    throw new Error(
      "External verification is not configured. Set KIT_EXTERNAL_ANCHOR_VERIFY_CMD before external sealing.",
    );
  }
  const statement = externalStatement(canonicalAuditLogPath(logPath), record);
  const issued = await issuer.anchor({
    tip: record.tip,
    count: record.count,
    logPath: statement.logPath,
    statement,
  });
  const receipt = receiptData(issued, statement);
  const verified = await verifyExternalAnchor(logPath, { ...record, external: receipt });
  if (verified.status !== "verified") throw new Error(verified.message);
  return receipt;
}

/** The trusted operator command receives data through stdin and compatibility environment fields. */
export function commandExternalAnchor(command: string): ExternalTimestampAnchor {
  return {
    async anchor(input) {
      const { runExternalProtocol } = await import("./audit-external-process.js");
      let output: string;
      try {
        output = await runExternalProtocol(command, {
          version: 1,
          operation: "anchor",
          requestId: randomUUID(),
          statement: input.statement ?? {
            tip: input.tip,
            count: input.count,
            logPath: input.logPath,
          },
          statementDigest: input.statement ? digest(input.statement) : undefined,
        });
      } catch {
        throw new Error("External anchor command failed.");
      }
      let value: unknown;
      try {
        value = JSON.parse(output);
      } catch {
        throw new Error("External anchor command did not emit a valid JSON receipt.");
      }
      const receipt = (value ?? {}) as Partial<ExternalAnchorReceipt>;
      if (typeof receipt.token !== "string" || !receipt.token.trim()) {
        throw new Error("External anchor receipt is missing a non-empty token.");
      }
      return {
        token: receipt.token,
        authority:
          typeof receipt.authority === "string" && receipt.authority
            ? receipt.authority
            : "command",
        timestamp:
          typeof receipt.timestamp === "string" && receipt.timestamp
            ? receipt.timestamp
            : new Date().toISOString(),
      };
    },
  };
}

export function resolveExternalAnchor(): ExternalTimestampAnchor | null {
  const command = (process.env.KIT_EXTERNAL_ANCHOR_CMD ?? "").trim();
  return command ? commandExternalAnchor(command) : null;
}

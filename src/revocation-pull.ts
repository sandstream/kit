/**
 * kit control plane (Pelare 2) — `kit policy pull-revocations`: fetch signed identity-key
 * revocations from a self-hostable source and MONOTONE-merge the authoritative ones into the local
 * append-only log (`revocations.jsonl`). Design: `pillar2-control-plane-5.0.md` §4.3.
 *
 * The identity-key revocation log (identity.ts) is consumed offline by policy verification, RBAC,
 * and shared-memory trust via `isRevokedWith`. Today it is local/append-only; this makes org
 * revocations DISTRIBUTABLE without adding any trust: every record carries its own Ed25519
 * signature, so kit verifies each one against the LOCAL org trust anchor before merging.
 *
 * Safe by construction (the confirmed §6 decisions):
 *   - **Add-only / monotone (§6.4):** merges via `appendRevocations`, which only appends new records
 *     (dedup by kid+ts+sig) — a pulled list can ADD revocations, NEVER "un-revoke" one. Omitting a
 *     kid from the source cannot resurrect a revoked key.
 *   - **Fail-closed authority:** only records that are AUTHORITATIVE (valid signature by an org
 *     trust-anchor signer, or a self-revoke) are merged; everything else is dropped and counted.
 *   - **No root-trust-from-the-network (§6.1):** the authority set is the LOCAL `.kit-policy.signers`
 *     anchor, never the source's; no local anchor ⇒ fail closed ("no-anchor").
 *   - **`file://` / local path only; manual trigger; offline** — air-gap is never affected.
 *
 * Deterministic, local-only, no telemetry, no egress.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pullSourceToPath } from "./policy-pull.js";
import {
  appendRevocations,
  isAuthoritativeRevocation,
  localPublicKeys,
  type RevocationRecord,
} from "./identity.js";
import { policySignersMap, getSignersPath } from "./policy-trust.js";

/** The distributed revocation feed filename (mirrors the local append-only log). */
export const REVOCATIONS_FEED_FILE = "revocations.jsonl";

export interface RevocationPullResult {
  ok: boolean;
  status: "merged" | "no-source" | "no-anchor";
  /** Authoritative records newly appended to the local log (monotone). */
  added: number;
  /** Records dropped because they were not authoritative (unsigned/forged/unauthorized revoker). */
  rejected: number;
  detail: string;
}

/** Parse a `revocations.jsonl` feed; malformed lines are skipped (fail-closed, never throw). */
function parseFeed(text: string): RevocationRecord[] {
  const out: RevocationRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as RevocationRecord);
    } catch {
      /* skip a malformed line — never let one bad record abort the merge */
    }
  }
  return out;
}

/**
 * Pull + monotone-merge authoritative revocations from `source` into the local log. `destRoot`
 * supplies the org trust anchor; `dir` is the identity dir holding the local log (defaults to the
 * standard identity dir). Never throws.
 */
export function pullRevocations(
  source: string,
  destRoot: string,
  dir?: string,
): RevocationPullResult {
  const feed = join(pullSourceToPath(source), REVOCATIONS_FEED_FILE);
  if (!existsSync(feed)) {
    return {
      ok: false,
      status: "no-source",
      added: 0,
      rejected: 0,
      detail: `no ${REVOCATIONS_FEED_FILE} at ${pullSourceToPath(source)}`,
    };
  }
  // §6.1 — authority comes from the LOCAL committed anchor, never the source. Without it we cannot
  // establish who may revoke, so fail closed (a pulled revocation couldn't be trusted regardless).
  if (!existsSync(getSignersPath(destRoot))) {
    return {
      ok: false,
      status: "no-anchor",
      added: 0,
      rejected: 0,
      detail: `no local .kit-policy.signers trust anchor — commit the org anchor out of band before pulling revocations`,
    };
  }

  const orgSigners = policySignersMap(destRoot);
  const trustedKeys = new Map<string, string>([...localPublicKeys(dir), ...orgSigners]);
  const authorities = new Set<string>(orgSigners.keys());

  const records = parseFeed(readFileSync(feed, "utf-8"));
  const authoritative = records.filter((r) =>
    isAuthoritativeRevocation(r, trustedKeys, authorities),
  );
  const rejected = records.length - authoritative.length;
  // Monotone union: append-only, dedup by kid+ts+sig — can only ADD, never un-revoke.
  const added = appendRevocations(authoritative, dir);

  return {
    ok: true,
    status: "merged",
    added,
    rejected,
    detail: `merged ${added} new revocation(s)${rejected ? `, dropped ${rejected} unauthorized` : ""}`,
  };
}

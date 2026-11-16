/**
 * `kit security incoming <sub>`: operator commands over the incoming-trust authority store.
 *
 * Subcommands: enroll, status, stage, request, approve, reject, retry, rotate, recover.
 * Signing happens outside kit. `approve` only verifies and records an approval that an external
 * signer produced. Nothing here runs the candidate, holds a launch lock or isolates a workload.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import { IncomingTrustStore, type IncomingTrustState } from "../incoming-trust/authority-store.js";
import { QUARANTINE_ACKNOWLEDGEMENT } from "../incoming-trust/authority-files.js";
import { captureIncomingCandidate } from "../incoming-trust/candidate-flow.js";
import {
  acceptCandidate,
  rejectCandidate,
  requestApproval,
  retryCandidate,
  stageCandidate,
} from "../incoming-trust/lifecycle.js";
import {
  incomingApproval,
  incomingAuthority,
  incomingVerification,
} from "../incoming-trust/decision-schema.js";
import type { IncomingCheck } from "../incoming-trust/decision.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const SUBCOMMANDS = [
  "enroll",
  "status",
  "stage",
  "request",
  "approve",
  "reject",
  "retry",
  "rotate",
  "recover",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export const SECURITY_INCOMING_USAGE =
  "kit security incoming enroll --authority <file> | status | stage --source <dir> --snapshot-dir <new dir> --origin <https url> | request --checks <file> [--out <file>] | approve --verification <file> --approval <file> | reject | retry | rotate --signers <file> | recover --acknowledge <text>   (all accept --repo <dir>, --store <dir>, --json)";

interface Invocation {
  argv: readonly string[];
  repository: string;
  store: IncomingTrustStore;
  json: boolean;
}

function readJsonFile(path: string | undefined, label: string): unknown {
  if (!path) throw new Error(`Incoming trust: ${label} is required`);
  const fd = openSync(resolve(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES)
      throw new Error(`Incoming trust: ${label} is not a regular file under 1 MiB`);
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function repeated(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((token, i) => {
    if (token === name && argv[i + 1] !== undefined) values.push(argv[i + 1]);
    else if (token.startsWith(`${name}=`)) values.push(token.slice(name.length + 1));
  });
  return values;
}

function describeState(state: IncomingTrustState | null) {
  if (!state) return { enrolled: false as const };
  return {
    enrolled: true as const,
    phase: state.phase,
    generation: state.authority.generation,
    candidateDigest: state.candidateDigest,
    signers: state.authority.signers.map((signer) => signer.id),
    approvalExpiresAt: state.acceptance?.approval.expiresAt ?? null,
  };
}

function show(inv: Invocation, value: Record<string, unknown>, text: string): boolean {
  console.log(inv.json ? JSON.stringify(value) : text);
  return true;
}

function summary(state: IncomingTrustState | null): string {
  const d = describeState(state);
  if (!d.enrolled) return "not enrolled";
  return `phase ${d.phase}, generation ${d.generation}, candidate ${d.candidateDigest ?? "none"}`;
}

function enroll(inv: Invocation): boolean {
  const authority = readJsonFile(flagValue(inv.argv, "--authority"), "--authority");
  if (!incomingAuthority(authority)) throw new Error("Incoming trust: invalid-authority");
  const state = inv.store.update(inv.repository, { type: "enroll", authority });
  return show(inv, describeState(state), `Enrolled: ${summary(state)}`);
}

function status(inv: Invocation): boolean {
  const state = inv.store.read(inv.repository);
  return show(inv, describeState(state), `Incoming trust: ${summary(state)}`);
}

async function stage(inv: Invocation): Promise<boolean> {
  const source = flagValue(inv.argv, "--source");
  const destination = flagValue(inv.argv, "--snapshot-dir");
  // The literal in flagValue keeps the flag in the derived flag surface; `repeated` reads every use.
  const origins =
    flagValue(inv.argv, "--origin") === undefined ? [] : repeated(inv.argv, "--origin");
  if (!source || !destination || origins.length === 0)
    throw new Error("Incoming trust: stage needs --source, --snapshot-dir and --origin");
  const flow = await captureIncomingCandidate({
    source: resolve(source),
    destination: resolve(destination),
    fetchPolicy: { origins },
  });
  if (flow.status === "refused") {
    console.error(
      `${c.red}Candidate refused: ${flow.reason}${c.reset}${
        flow.snapshot ? ` (snapshot kept at ${flow.snapshot.tree})` : ""
      }`,
    );
    return false;
  }
  const state = stageCandidate(
    inv.store,
    inv.repository,
    flow.candidate.candidateDigest,
    flow.candidate.checks,
  );
  return show(inv, describeState(state), `Staged: ${summary(state)}`);
}

function parseChecks(value: unknown): IncomingCheck[] {
  if (!Array.isArray(value)) throw new Error("Incoming trust: --checks must be a JSON array");
  return value.map((item) => {
    const check = item as Partial<IncomingCheck> | null;
    if (
      !check ||
      typeof check.id !== "string" ||
      typeof check.evidenceDigest !== "string" ||
      !["pass", "fail", "skipped"].includes(check.status as string)
    )
      throw new Error("Incoming trust: invalid check entry");
    return { id: check.id, status: check.status!, evidenceDigest: check.evidenceDigest };
  });
}

function writeNewFile(path: string, body: string): void {
  const fd = openSync(
    resolve(path),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
}

function request(inv: Invocation): boolean {
  const checks = parseChecks(readJsonFile(flagValue(inv.argv, "--checks"), "--checks"));
  const result = requestApproval(inv.store, inv.repository, checks, Date.now());
  const out = flagValue(inv.argv, "--out");
  if (out) writeNewFile(out, JSON.stringify(result.verification));
  return show(
    inv,
    { verificationDigest: result.verificationDigest, verification: result.verification },
    `Sign this digest with the enrolled authority: ${result.verificationDigest}${
      out ? `\nVerification report written to ${resolve(out)}` : ""
    }`,
  );
}

function approve(inv: Invocation): boolean {
  const verification = readJsonFile(flagValue(inv.argv, "--verification"), "--verification");
  const approval = readJsonFile(flagValue(inv.argv, "--approval"), "--approval");
  if (!incomingVerification(verification) || !incomingApproval(approval))
    throw new Error("Incoming trust: invalid-approval-input");
  const state = acceptCandidate(inv.store, inv.repository, verification, approval, Date.now());
  return show(inv, describeState(state), `Accepted: ${summary(state)}`);
}

function simple(
  inv: Invocation,
  verb: string,
  run: (store: IncomingTrustStore, repository: string) => IncomingTrustState,
): boolean {
  const state = run(inv.store, inv.repository);
  return show(inv, describeState(state), `${verb}: ${summary(state)}`);
}

function rotate(inv: Invocation): boolean {
  const signers = readJsonFile(flagValue(inv.argv, "--signers"), "--signers");
  const state = inv.store.read(inv.repository);
  if (!state) throw new Error("Incoming trust: not-enrolled");
  const next = inv.store.update(inv.repository, {
    type: "rotate",
    expectedGeneration: state.authority.generation,
    expectedPhase: state.phase,
    signers: signers as never,
  });
  return show(inv, describeState(next), `Rotated: ${summary(next)}`);
}

function recover(inv: Invocation): boolean {
  const acknowledgement = flagValue(inv.argv, "--acknowledge");
  if (acknowledgement !== QUARANTINE_ACKNOWLEDGEMENT)
    throw new Error(
      `Incoming trust: recover moves a damaged store aside and every repository then needs a new enrollment. Repeat with --acknowledge ${QUARANTINE_ACKNOWLEDGEMENT}`,
    );
  const result = inv.store.quarantineDamaged(inv.repository, QUARANTINE_ACKNOWLEDGEMENT);
  return show(
    inv,
    { quarantinedTo: result.quarantinedTo },
    `Damaged store moved to ${result.quarantinedTo}. Enroll each repository again.`,
  );
}

const HANDLERS: Record<Subcommand, (inv: Invocation) => boolean | Promise<boolean>> = {
  enroll,
  status,
  stage,
  request,
  approve,
  reject: (inv) => simple(inv, "Rejected", rejectCandidate),
  retry: (inv) => simple(inv, "Retry started", retryCandidate),
  rotate,
  recover,
};

/** `argv` starts after `incoming`: the subcommand first, then its flags. */
export async function cmdSecurityIncoming(argv: readonly string[]): Promise<boolean> {
  const sub = argv[0] as Subcommand | undefined;
  if (!sub || !SUBCOMMANDS.includes(sub)) {
    console.error(`${c.red}Usage: ${SECURITY_INCOMING_USAGE}${c.reset}`);
    return false;
  }
  const storeDirectory = flagValue(argv, "--store");
  const inv: Invocation = {
    argv,
    repository: resolve(flagValue(argv, "--repo") ?? process.cwd()),
    store: storeDirectory
      ? new IncomingTrustStore(resolve(storeDirectory))
      : new IncomingTrustStore(),
    json: hasFlag(argv, "--json"),
  };
  try {
    return await HANDLERS[sub](inv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed";
    console.error(
      `${c.red}${message.startsWith("Incoming trust") ? message : `Incoming trust: ${message}`}${c.reset}`,
    );
    return false;
  }
}

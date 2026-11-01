/**
 * Hook surface for `kit services`. These run inside the existing `kit memory hook` events
 * (UserPromptSubmit, SessionStart, SessionEnd), so a user who installed kit's memory hooks gets
 * them with no new wiring.
 *
 * HOT PATH. Every function here reads (and at most rewrites) the registry file. None of them calls
 * docker or probes a process: a prompt hook that waits on `docker ps` would slow every prompt, and
 * a hook must never fail the prompt. All of them are fail-open and return "" or [] on any error.
 */

import { sep } from "node:path";
import { leaseActive, mutateRegistry, readRegistry, servicesFile } from "./registry.js";
import { describeOwner } from "./owner.js";

const SOON_MS = 30 * 60 * 1000;

function minutesLeft(leaseUntil: string, now: number): number {
  return Math.max(0, Math.round((Date.parse(leaseUntil) - now) / 60_000));
}

/**
 * One short line for the owning session: stop requests waiting for an answer, and leases that
 * end within 30 minutes. "" when there is nothing to say.
 */
export function servicesPromptNotice(
  sessionId: string | undefined,
  now: number = Date.now(),
  path: string = servicesFile(),
): string {
  if (!sessionId) return "";
  try {
    const mine = readRegistry(path).services.filter((e) => e.owner.session === sessionId);
    const parts: string[] = [];
    for (const e of mine) {
      if (e.stopRequest) {
        const msg = e.stopRequest.message ? ` ("${e.stopRequest.message.slice(0, 80)}")` : "";
        parts.push(
          `${describeOwner(e.stopRequest.by)} asks to stop "${e.name}"${msg}: answer with \`kit services keep ${e.name}\` or \`kit services release ${e.name}\``,
        );
      } else if (!leaseActive(e, now)) {
        parts.push(
          `lease on "${e.name}" has ended, so anyone may stop it: \`kit services renew ${e.name}\` if you still need it`,
        );
      } else if (Date.parse(e.leaseUntil) - now <= SOON_MS) {
        parts.push(
          `lease on "${e.name}" ends in ${minutesLeft(e.leaseUntil, now)} min: \`kit services renew ${e.name}\` or stop it when done`,
        );
      }
    }
    return parts.length ? `kit services: ${parts.join("; ")}.` : "";
  } catch {
    return "";
  }
}

/**
 * SessionStart: a resumed session takes its entries back (clears `ownerEndedAt`), and the session
 * hears about entries in this project whose owning session has ended. Returns the context lines.
 */
export function servicesSessionStart(
  sessionId: string | undefined,
  project: string,
  now: number = Date.now(),
  path: string = servicesFile(),
): string[] {
  const lines: string[] = [];
  try {
    if (sessionId) {
      const resumed = readRegistry(path).services.some(
        (e) => e.owner.session === sessionId && e.ownerEndedAt,
      );
      if (resumed) {
        mutateRegistry((reg) => {
          for (const e of reg.services) if (e.owner.session === sessionId) delete e.ownerEndedAt;
          return { result: undefined };
        }, path);
      }
    }
    const own = servicesPromptNotice(sessionId, now, path);
    if (own) lines.push(own);
    const orphans = readRegistry(path).services.filter(
      (e) =>
        (e.project === project || e.project.startsWith(project + sep)) &&
        e.ownerEndedAt &&
        e.owner.session !== sessionId,
    );
    if (orphans.length > 0) {
      const names = orphans
        .slice(0, 4)
        .map((e) => `${e.name}${leaseActive(e, now) ? "" : " (lease ended)"}`)
        .join(", ");
      const more = orphans.length > 4 ? ` and ${orphans.length - 4} more` : "";
      lines.push(
        `kit services: ${orphans.length} service(s) for this project belong to sessions that have ended: ${names}${more}. Run \`kit services ls\` to see whether they still run.`,
      );
    }
  } catch {
    /* fail-open */
  }
  return lines;
}

/**
 * SessionEnd: mark every entry this session owns, so `ls` and the next session can tell the owner
 * is gone. Returns the names it marked. A hook's stdout at SessionEnd reaches no one, which is why
 * the mark is recorded instead of printed.
 */
export function servicesSessionEnd(
  sessionId: string | undefined,
  now: number = Date.now(),
  path: string = servicesFile(),
): string[] {
  if (!sessionId) return [];
  try {
    const owned = readRegistry(path).services.filter((e) => e.owner.session === sessionId);
    if (owned.length === 0) return [];
    return mutateRegistry((reg) => {
      const names: string[] = [];
      for (const e of reg.services) {
        if (e.owner.session !== sessionId) continue;
        e.ownerEndedAt = new Date(now).toISOString();
        names.push(e.name);
      }
      return { result: names };
    }, path);
  } catch {
    return [];
  }
}

/**
 * The session id for a hook: the harness payload's `session_id` on stdin first (Claude Code and
 * Codex both send JSON), then the environment. Never waits more than `timeoutMs` for stdin, and
 * never reads a TTY, so a manual `kit memory hook ...` in a terminal does not hang.
 */
export async function hookSessionId(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 400,
): Promise<string | undefined> {
  const fromEnv =
    env.CODEX_THREAD_ID?.trim() ||
    env.CODEX_SESSION_ID?.trim() ||
    env.CLAUDE_CODE_SESSION_ID?.trim() ||
    undefined;
  if (process.stdin.isTTY) return fromEnv;
  const raw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
  });
  try {
    const id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
    if (typeof id === "string" && id.trim()) return id.trim();
  } catch {
    /* no payload, or not JSON */
  }
  return fromEnv;
}

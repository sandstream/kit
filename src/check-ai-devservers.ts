/**
 * Local AI dev servers listening on a non-loopback interface, beyond the Ollama row.
 *
 * Internet scanners probe the default ports and paths of AI tooling (kit-research
 * `huginn-honeypot-vs-kit`: at least 111 of Krawl's rules name AI and agent tools). The Ollama
 * row reads the listener table (`ss`, then `netstat`) and calls `0.0.0.0` / `::` exposed and
 * `127.0.0.1` local. This row does the same for the default ports below, without a shell:
 *   - Linux: `/proc/net/tcp` and `/proc/net/tcp6`, then `ss -Htln`, then `netstat -tln`;
 *   - macOS: `netstat -an -p tcp`; Windows: `netstat -an`.
 * Deterministic and local: it reads this machine's own listener table and connects to nothing.
 * It matches the port, not the process, and says so.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { SecurityCheckResult } from "./check-security.js";

const exec = promisify(execFile);

/** Default ports of AI dev servers. Ollama (11434) has its own row. */
export const AI_DEV_PORTS: ReadonlyMap<number, string> = new Map([
  [1234, "LM Studio"],
  [8000, "vLLM / OpenAI-compatible server"],
  [8188, "ComfyUI"],
  [7860, "Gradio"],
  [8888, "Jupyter"],
  [6274, "MCP Inspector UI"],
  [6277, "MCP Inspector proxy"],
]);

export interface Listener {
  host: string;
  port: number;
}

/** True for an address only this machine can reach: 127.0.0.0/8, `::1` or `::ffff:127.x`. Pure. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "::1" || h === "localhost" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(h);
}

/** `127.0.0.1:8000`, `[::]:8000`, `*:8000`, `:::8000` or macOS's `*.8000` / `127.0.0.1.8000`. */
function splitAddress(addr: string): Listener | null {
  const a = addr.replace(/%[^:\]]+/, "");
  const m = /^(.*)[:.](\d+)$/.exec(a);
  if (!m) return null;
  return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

/** Listeners in `ss -Htln`, Linux `netstat -tln`, macOS `netstat -an` or Windows `netstat -an`. Pure. */
export function parseListenerTable(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || !/LISTEN/i.test(line)) continue;
    // Windows puts the local address second; ss and both netstats put it fourth, after two counts.
    const l = splitAddress(f[1]) ?? splitAddress(f[3]);
    if (l) out.push(l);
  }
  return out;
}

function hexIpv4(hex: string): string {
  const b = (hex.match(/../g) ?? []).map((x) => parseInt(x, 16)).reverse();
  return b.join(".");
}

function hexIpv6(hex: string): string {
  // Four 32-bit words, each in host (little-endian) byte order.
  const bytes: number[] = [];
  for (const word of hex.match(/.{8}/g) ?? []) {
    bytes.push(...(word.match(/../g) ?? []).map((x) => parseInt(x, 16)).reverse());
  }
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255)
    return `::ffff:${bytes.slice(12).join(".")}`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  const full = groups.join(":");
  if (full === "0:0:0:0:0:0:0:0") return "::";
  if (full === "0:0:0:0:0:0:0:1") return "::1";
  return full;
}

/** Listening sockets (state 0A) in `/proc/net/tcp` or `/proc/net/tcp6`. Pure. */
export function parseProcNetTcp(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[3] !== "0A") continue;
    const [ip, port] = f[1].split(":");
    if (!ip || !port) continue;
    out.push({ host: ip.length === 8 ? hexIpv4(ip) : hexIpv6(ip), port: parseInt(port, 16) });
  }
  return out;
}

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await exec(cmd, args, { timeout: 5_000, windowsHide: true })).stdout;
  } catch {
    return null;
  }
}

function readProc(): Listener[] | null {
  const out: Listener[] = [];
  let read = false;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      out.push(...parseProcNetTcp(readFileSync(file, "utf8")));
      read = true;
    } catch {
      // absent (no IPv6) or not Linux
    }
  }
  return read ? out : null;
}

/** This machine's TCP listeners, or null when no source could be read. */
export async function readListeners(
  platform: NodeJS.Platform = process.platform,
): Promise<Listener[] | null> {
  if (platform === "linux") {
    const proc = readProc();
    if (proc) return proc;
    const table = (await run("ss", ["-Htln"])) ?? (await run("netstat", ["-tln"]));
    return table === null ? null : parseListenerTable(table);
  }
  // Windows' `-p TCP` would leave out IPv6; plain `-an` lists both, and only TCP rows say LISTENING.
  const table = await run("netstat", platform === "win32" ? ["-an"] : ["-an", "-p", "tcp"]);
  return table === null ? null : parseListenerTable(table);
}

/** The rows for a listener table: one warn per exposed AI dev port, or one pass. Pure. */
export function aiDevServerRows(listeners: Listener[] | null): SecurityCheckResult[] {
  const name = "AI dev servers";
  if (listeners === null)
    return [
      {
        category: "exposure",
        name,
        status: "skip",
        detail: "could not determine exposure: no /proc/net/tcp, ss or netstat",
      },
    ];
  const rows: SecurityCheckResult[] = [];
  for (const [port, tool] of AI_DEV_PORTS) {
    const hosts = [
      ...new Set(
        listeners.filter((l) => l.port === port && !isLoopbackHost(l.host)).map((l) => l.host),
      ),
    ];
    if (hosts.length === 0) continue;
    const shown = hosts.map((h) => (h === "*" ? "all interfaces" : h)).join(", ");
    rows.push({
      category: "exposure",
      name: `${tool} port ${port}`,
      status: "warn",
      severity: "medium",
      detail: `port ${port} (${tool} default) is listening on ${shown}, not only 127.0.0.1: other hosts on the network can reach it. kit matched the port, not the process`,
      suggestion: `bind the server to 127.0.0.1 (for example --host 127.0.0.1), or firewall port ${port}`,
    });
  }
  if (rows.length > 0) return rows;
  const ports = [...AI_DEV_PORTS.keys()].join(", ");
  return [
    {
      category: "exposure",
      name,
      status: "pass",
      detail: `no listener on a non-loopback interface on ports ${ports}`,
    },
  ];
}

/** `kit check`'s row for AI dev servers exposed beyond loopback. */
export async function checkAiDevServers(): Promise<SecurityCheckResult[]> {
  return aiDevServerRows(await readListeners());
}

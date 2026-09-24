import { randomBytes, createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  linkSync,
  rmSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, dirname } from "node:path";

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Kept independent of db.ts so identity resolution never opens or migrates a store. */
function deviceIdPath(): string {
  const dir = process.env.KIT_MEMORY_DIR ?? join(homedir(), ".kit");
  return join(dir, "device-id");
}

/** Last resort only: host-derived identity drifts when the hostname changes. */
function hostnameDeviceId(): string {
  try {
    return createHash("sha256")
      .update(`${hostname()}\x1f${userInfo().username}`)
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "unknown";
  }
}

/**
 * A valid override is trust-bearing: on a shared store it can surface or suppress
 * another device's actions. Callers surface a warning when it is active.
 */
export function deviceIdOverrideActive(): boolean {
  const override = (process.env.KIT_DEVICE_ID ?? "").trim();
  return override !== "" && DEVICE_ID_RE.test(override);
}

function readDeviceId(path: string): string {
  const saved = readFileSync(path, "utf8").trim();
  if (!DEVICE_ID_RE.test(saved)) throw new Error("Invalid persisted device identity");
  return saved;
}

/**
 * Resolve this device's identity from a valid override, then a persisted random
 * identifier (0600), then the host/user fallback if persistence is unavailable.
 * Persisted identity survives hostname churn; malformed overrides are ignored.
 * Invalid existing files are never replaced implicitly.
 */
export function resolveDeviceIdentity(opts: { persist?: boolean } = {}): {
  id: string;
  source: "override" | "persisted" | "fallback";
} {
  const override = (process.env.KIT_DEVICE_ID ?? "").trim();
  if (override && DEVICE_ID_RE.test(override)) return { id: override, source: "override" };
  try {
    const path = deviceIdPath();
    if (existsSync(path)) return { id: readDeviceId(path), source: "persisted" };
    if (opts.persist === false) return { id: hostnameDeviceId(), source: "fallback" };
    const fresh = randomBytes(8).toString("hex");
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(dir, ".device-id-"));
    try {
      const candidate = join(staging, "id");
      writeFileSync(candidate, fresh + "\n", { mode: 0o600 });
      try {
        // Publish complete bytes without replacing a concurrently published identity.
        linkSync(candidate, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return { id: readDeviceId(path), source: "persisted" };
      }
      return { id: fresh, source: "persisted" };
    } finally {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // A private staging-cleanup failure must not change a published identity.
      }
    }
  } catch {
    return { id: hostnameDeviceId(), source: "fallback" };
  }
}

export function deviceId(opts: { persist?: boolean } = {}): string {
  return resolveDeviceIdentity(opts).id;
}

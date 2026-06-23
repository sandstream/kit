import { connect } from "node:tls";
import type { HealthFinding, HealthSensor } from "../health.js";

export interface CertInfo {
  validTo?: string;
}

/** Whole days until `validTo` relative to `now` (negative = already expired); null on unparseable. */
export function daysUntilExpiry(validTo: string, now: number): number | null {
  const t = Date.parse(validTo);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / 86_400_000);
}

/** Pure decision: days-left + warn threshold → the finding (no I/O, fully testable). */
export function evaluateCert(
  host: string,
  daysLeft: number | null,
  warnDays: number,
): HealthFinding {
  const source = `${host}:443`;
  if (daysLeft === null) {
    return {
      sensor: "tls-cert",
      source,
      status: "unknown",
      title: `TLS cert for ${host}: could not read expiry`,
    };
  }
  if (daysLeft < 0) {
    return {
      sensor: "tls-cert",
      source,
      status: "red",
      severity: "critical",
      title: `TLS cert for ${host} EXPIRED ${-daysLeft} day(s) ago`,
      detail: "renew the certificate now",
      suggestedClass: "human",
    };
  }
  if (daysLeft <= warnDays) {
    return {
      sensor: "tls-cert",
      source,
      status: "red",
      severity: "high",
      title: `TLS cert for ${host} expires in ${daysLeft} day(s)`,
      detail: `renew before expiry (warn threshold ${warnDays}d)`,
      suggestedClass: "human",
    };
  }
  return {
    sensor: "tls-cert",
    source,
    status: "green",
    title: `TLS cert for ${host} valid (${daysLeft} day(s) left)`,
  };
}

/** Live cert fetch over a TLS handshake; resolves null on any connect/timeout error. */
function fetchCert(host: string, timeoutMs: number): Promise<CertInfo | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert && cert.valid_to ? { validTo: cert.valid_to } : null);
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

export const tlsCertSensor: HealthSensor = {
  id: "tls-cert",
  async probe(_ctx, _deps): Promise<HealthFinding[]> {
    const hosts = (process.env.KIT_TLS_HOST ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (hosts.length === 0) {
      return [
        {
          sensor: "tls-cert",
          source: "(KIT_TLS_HOST unset)",
          status: "unknown",
          title: "TLS-cert probe skipped: KIT_TLS_HOST not set",
          detail: "set KIT_TLS_HOST=example.com[,other.com] to enable cert-expiry checks",
        },
      ];
    }
    const warnDays = Number(process.env.KIT_TLS_WARN_DAYS ?? "21") || 21;
    const out: HealthFinding[] = [];
    for (const host of hosts) {
      const cert = await fetchCert(host, 10_000);
      const daysLeft = cert?.validTo ? daysUntilExpiry(cert.validTo, Date.now()) : null;
      out.push(evaluateCert(host, daysLeft, warnDays));
    }
    return out;
  },
};

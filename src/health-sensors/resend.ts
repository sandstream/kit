import type { HealthFinding, HealthSensor } from "../health.js";

export interface ResendDomain {
  id?: string;
  name?: string;
  status?: string;
}

export function parseResendDomains(body: string): ResendDomain[] {
  try {
    const obj = JSON.parse(body) as { data?: ResendDomain[] };
    return Array.isArray(obj.data) ? obj.data : [];
  } catch {
    return [];
  }
}

/** Domains whose status is anything other than "verified". */
export function unverifiedDomains(domains: ResendDomain[]): ResendDomain[] {
  return domains.filter((d) => (d.status ?? "") !== "verified");
}

export const resendSensor: HealthSensor = {
  id: "resend",
  async probe(_ctx, deps): Promise<HealthFinding[]> {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      return [{
        sensor: "resend",
        source: "resend",
        status: "unknown",
        title: "Resend probe skipped: RESEND_API_KEY not set",
        detail: "set RESEND_API_KEY to enable the Resend sensor",
      }];
    }
    const res = await deps.httpGet("https://api.resend.com/domains", { Authorization: `Bearer ${key}` });
    if (!res.ok) {
      return [{
        sensor: "resend",
        source: "resend",
        status: "unknown",
        title: `Resend API returned HTTP ${res.status}`,
        detail: "check RESEND_API_KEY",
      }];
    }
    const bad = unverifiedDomains(parseResendDomains(res.body));
    if (bad.length === 0) {
      return [{ sensor: "resend", source: "resend", status: "green", title: "Resend: all sending domains verified" }];
    }
    const names = bad.map((d) => `${d.name ?? "?"}=${d.status ?? "?"}`).join(", ");
    return [{
      sensor: "resend",
      source: "resend",
      status: "red",
      severity: "high",
      title: `Resend: ${bad.length} domain(s) not verified`,
      detail: `${names} — re-check DNS (SPF/DKIM/DMARC); customer/DNS action, not a code fix`,
      suggestedClass: "human",
    }];
  },
};

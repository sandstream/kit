import type { HealthFinding, HealthSensor } from "../health.js";

export interface SupabaseLint {
  name?: string;
  level?: string; // "ERROR" | "WARN" | "INFO"
  title?: string;
  description?: string;
  categories?: string[];
}

/** Parses the Supabase advisors response (`{ lints: [...] }` or a bare array). */
export function parseSupabaseLints(body: string): SupabaseLint[] {
  try {
    const obj = JSON.parse(body) as { lints?: SupabaseLint[] } | SupabaseLint[];
    if (Array.isArray(obj)) return obj;
    return Array.isArray(obj.lints) ? obj.lints : [];
  } catch {
    return [];
  }
}

/** Lints at ERROR level — the ones worth going red on (RLS gaps, exposure). */
export function errorLints(lints: SupabaseLint[]): SupabaseLint[] {
  return lints.filter((l) => (l.level ?? "").toUpperCase() === "ERROR");
}

export const supabaseAdvisorSensor: HealthSensor = {
  id: "supabase-advisor",
  async probe(_ctx, deps): Promise<HealthFinding[]> {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    const ref = process.env.SUPABASE_PROJECT_REF;
    const source = ref ? `supabase/${ref}` : "(supabase project ref unset)";
    if (!token || !ref) {
      return [{
        sensor: "supabase-advisor",
        source,
        status: "unknown",
        title: "Supabase advisor probe skipped: SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF not both set",
        detail: "set both to enable the Supabase security-advisor sensor",
      }];
    }
    // Management API security advisors (the RLS/exposure lints the dashboard shows).
    const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/advisors/security`;
    const res = await deps.httpGet(url, { Authorization: `Bearer ${token}` });
    if (!res.ok) {
      return [{
        sensor: "supabase-advisor",
        source,
        status: "unknown",
        title: `Supabase advisor API returned HTTP ${res.status}`,
        detail: "check SUPABASE_ACCESS_TOKEN scope / SUPABASE_PROJECT_REF",
      }];
    }
    const errs = errorLints(parseSupabaseLints(res.body));
    if (errs.length === 0) {
      return [{ sensor: "supabase-advisor", source, status: "green", title: "Supabase: no ERROR-level security advisors" }];
    }
    const sample = errs[0]?.title ? ` (e.g. "${errs[0].title}")` : "";
    return [{
      sensor: "supabase-advisor",
      source,
      status: "red",
      severity: "high",
      title: `Supabase: ${errs.length} ERROR-level security advisor(s)${sample}`,
      detail: "review Supabase → Advisors; likely RLS-disabled / exposed-data lints — a code/policy fix",
      suggestedClass: "code",
    }];
  },
};

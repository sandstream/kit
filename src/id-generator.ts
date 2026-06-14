/**
 * Centralized ID generation utility
 * Consolidates Date.now() + random pattern used across services
 */

/**
 * Generate unique ID with optional prefix
 * Pattern: prefix + timestamp-randomString (max 255 chars)
 */
export function generateId(prefix: string = ""): string {
  const id = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return id.slice(0, 255);
}

/**
 * Generate prefixed IDs for domain entities
 */
export const IdGenerators = {
  partner: (suffix?: string) => generateId(`partner-${suffix || ""}`),
  agreement: (suffix?: string) => generateId(`agree-${suffix || ""}`),
  apiKey: (suffix?: string) => generateId(`key-${suffix || ""}`),
  coPlugin: (suffix?: string) => generateId(`coplugin-${suffix || ""}`),
  featured: (suffix?: string) => generateId(`featured-${suffix || ""}`),
  feedback: (suffix?: string) => generateId(`feedback-${suffix || ""}`),
  betaDev: (suffix?: string) => generateId(`betadev-${suffix || ""}`),
  refine: (suffix?: string) => generateId(`refine-${suffix || ""}`),
  payout: (suffix?: string) => generateId(`payout-${suffix || ""}`),
  grant: (suffix?: string) => generateId(`grant-${suffix || ""}`),
  approval: (suffix?: string) => generateId(`approval-${suffix || ""}`),
  alert: (suffix?: string) => generateId(`alert-${suffix || ""}`),
  trace: (suffix?: string) => generateId(`trace-${suffix || ""}`),
  span: (suffix?: string) => generateId(`span-${suffix || ""}`),
  notification: (suffix?: string) => generateId(`notif-${suffix || ""}`),
  publish: (suffix?: string) => generateId(`pub-${suffix || ""}`),
  documentation: (suffix?: string) => generateId(`doc-${suffix || ""}`),
  error: (suffix?: string) => generateId(`error-${suffix || ""}`),
  errorGroup: (suffix?: string) => generateId(`group-${suffix || ""}`),
  search: (suffix?: string) => generateId(`search-${suffix || ""}`),
  review: (suffix?: string) => generateId(`review-${suffix || ""}`),
  report: (suffix?: string) => generateId(`report-${suffix || ""}`),
  modAction: (suffix?: string) => generateId(`action-${suffix || ""}`),
  appeal: (suffix?: string) => generateId(`appeal-${suffix || ""}`),
  audit: (suffix?: string) => generateId(`audit-${suffix || ""}`),
  policy: (suffix?: string) => generateId(`policy-${suffix || ""}`),
  transaction: (suffix?: string) => generateId(`txn-${suffix || ""}`),
  sla: (suffix?: string) => generateId(`sla-${suffix || ""}`),
  breach: (suffix?: string) => generateId(`breach-${suffix || ""}`),
};

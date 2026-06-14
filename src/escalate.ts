import type { ToolStatus } from "./check-tools.js";
import type { ServiceStatus } from "./check-services.js";
import type { SecretStatus } from "./check-secrets.js";

export interface EscalationItem {
  category: "tool" | "service" | "secret";
  name: string;
  issue: string;
  action: string;
}

export function collectEscalations(
  tools: ToolStatus[],
  services: ServiceStatus[],
  secrets: SecretStatus[],
): EscalationItem[] {
  const items: EscalationItem[] = [];

  for (const t of tools) {
    if (!t.ok) {
      items.push({
        category: "tool",
        name: t.name,
        issue: t.installed
          ? `Version ${t.installed} does not satisfy ${t.required}`
          : "Not installed",
        action: `Run: mise install ${t.name}@${t.required}`,
      });
    }
  }

  for (const s of services) {
    if (!s.authenticated) {
      items.push({
        category: "service",
        name: s.name,
        issue: "Not authenticated",
        action: `Run: ${s.checkCommand.replace(/\bstatus\b|whoami|--list/g, "login").trim()}`,
      });
    }
  }

  for (const s of secrets) {
    if (!s.available) {
      items.push({
        category: "secret",
        name: s.name,
        issue: s.detail,
        action: s.source === "1password"
          ? "Retrieve from 1Password"
          : s.source === "eas"
            ? "Set via eas secret:push"
            : s.source === "infisical"
              ? "Add to Infisical project (infisical secrets set)"
              : s.source === "bitwarden"
                ? "Add to Bitwarden vault"
                : s.source === "doppler"
                  ? "Add to Doppler project"
                  : `Set ${s.name} in environment`,
      });
    }
  }

  return items;
}

export function formatEscalationMessage(
  items: EscalationItem[],
  projectDir: string,
): string {
  if (items.length === 0) {
    return "All checks passed — no manual action needed.";
  }

  const lines: string[] = [
    `kit: ${items.length} issue${items.length === 1 ? "" : "s"} need manual action`,
    `Project: ${projectDir}`,
    "",
  ];

  const byCategory = new Map<string, EscalationItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  for (const [category, categoryItems] of byCategory) {
    const label = category === "tool" ? "Tools" : category === "service" ? "Services" : "Secrets";
    lines.push(`${label}:`);
    for (const item of categoryItems) {
      lines.push(`  - ${item.name}: ${item.issue}`);
      lines.push(`    ${item.action}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

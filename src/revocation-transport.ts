export interface RevocationStatus {
  revoked: boolean;
  reason?: string;
  timestamp?: string;
}

export type RevocationObservation =
  { verified: true; status: RevocationStatus } | { verified: false; error: string };

/** Read a fresh verdict without caching it or treating a transport failure as confirmed revocation. */
export async function readRevocationStatus(input: {
  endpoint?: string;
  agentId?: string;
}): Promise<RevocationObservation> {
  if (!input.endpoint || !input.agentId) {
    return {
      verified: false,
      error: "Revocation requires revocation_endpoint and agent.id. Access cannot be verified.",
    };
  }
  try {
    let marker = "__kit_agent_identity__";
    while (input.endpoint.includes(marker)) marker += "_";
    const encodedId = encodeURIComponent(input.agentId);
    const template = new URL(input.endpoint.replaceAll("{agent_id}", marker));
    const endpoint = input.endpoint.replaceAll("{agent_id}", encodedId);
    if (new URL(endpoint).pathname !== template.pathname.replaceAll(marker, encodedId)) {
      return { verified: false, error: "Agent identity changes the revocation endpoint path." };
    }
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { verified: false, error: `Revocation check failed (HTTP ${response.status}).` };
    }
    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("revoked" in data) ||
      typeof data.revoked !== "boolean"
    ) {
      return {
        verified: false,
        error: "Revocation response requires a boolean revoked field.",
      };
    }
    return { verified: true, status: data as RevocationStatus };
  } catch {
    return {
      verified: false,
      error: "Could not verify revocation status. Check the endpoint and response.",
    };
  }
}

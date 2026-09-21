export const LEGACY_STATE_FIELDS = [
  "status",
  "title",
  "detail",
  "scope",
  "created_at",
  "next_check",
  "snooze_until",
  "closed_at",
  "claimed_by",
  "claimed_at",
] as const;
export const STATE_FIELDS = [...LEGACY_STATE_FIELDS, "claim_owner"] as const;

export interface PalClaimOwner {
  device: string;
  harness: string;
  session: string;
}

/** Absence denotes the historical ten-field format; null denotes unknown ownership. */
export type PortablePalState = Record<(typeof LEGACY_STATE_FIELDS)[number], string | null> & {
  claim_owner?: PalClaimOwner | null;
};

export function parseClaimOwner(value: unknown): PalClaimOwner {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RangeError("Claim owner must contain device, harness and session");
  const owner = value as Record<string, unknown>;
  if (
    Object.keys(owner).sort().join("\0") !== "device\0harness\0session" ||
    [owner.device, owner.harness, owner.session].some(
      (part) =>
        typeof part !== "string" ||
        !part.trim() ||
        part.trim() !== part ||
        part.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(part),
    )
  )
    throw new RangeError("Invalid claim owner identity");
  return {
    device: owner.device as string,
    harness: owner.harness as string,
    session: owner.session as string,
  };
}

export function storedClaimOwner(value: unknown): PalClaimOwner | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Invalid claim owner encoding");
    }
  }
  return value == null ? null : parseClaimOwner(value);
}

export function portableState(row: Record<string, unknown>, legacy = false): PortablePalState {
  const state = Object.fromEntries(LEGACY_STATE_FIELDS.map((field) => [field, row[field] ?? null]));
  if (
    LEGACY_STATE_FIELDS.some(
      (field) => state[field] !== null && typeof state[field] !== "string",
    ) ||
    !["open", "claimed", "snoozed", "closed"].includes(String(state.status)) ||
    typeof state.title !== "string"
  )
    throw new Error("Invalid portable pending-action state");
  if (!legacy && Object.hasOwn(row, "claim_owner")) {
    state.claim_owner = row.claim_owner === null ? null : parseClaimOwner(row.claim_owner);
    if (state.claim_owner !== null && state.status !== "claimed")
      throw new Error("Only claimed tasks may retain an owner");
  }
  return state as PortablePalState;
}

/** SQLite cells encode the owner; immutable JSON must carry the object itself. */
export function rowState(row: Record<string, unknown>, legacy = false): PortablePalState {
  if (legacy || !Object.hasOwn(row, "claim_owner")) return portableState(row, legacy);
  return portableState({ ...row, claim_owner: storedClaimOwner(row.claim_owner) });
}

export function isCompleteState(state: unknown): state is PortablePalState {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const keys = Object.keys(state).sort().join("\0");
  return [LEGACY_STATE_FIELDS, STATE_FIELDS].some(
    (fields) => keys === [...fields].sort().join("\0"),
  );
}

/** Normalize only for comparison; original immutable revision shape remains unchanged. */
export function stateKey(state: PortablePalState): string {
  return JSON.stringify({ ...state, claim_owner: state.claim_owner ?? null });
}

export function stateValues(state: PortablePalState): (string | null)[] {
  return STATE_FIELDS.map((field) =>
    field === "claim_owner"
      ? state.claim_owner
        ? JSON.stringify(state.claim_owner)
        : null
      : state[field],
  );
}

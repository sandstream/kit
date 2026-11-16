export interface IncomingSnapshotLimits {
  maxEntries: number;
  maxBytes: number;
  maxFileBytes: number;
  maxDepth: number;
  maxPathBytes: number;
  maxManifestBytes: number;
}

const defaults: IncomingSnapshotLimits = {
  maxEntries: 100_000,
  maxBytes: 1024 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxDepth: 64,
  maxPathBytes: 4096,
  maxManifestBytes: 16 * 1024 * 1024,
};

export function snapshotLimits(
  input: Partial<IncomingSnapshotLimits> = {},
): IncomingSnapshotLimits {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Incoming snapshot: invalid-limits");
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(defaults, name) || !Number.isSafeInteger(value) || value < 0)
      throw new Error("Incoming snapshot: invalid-limits");
  }
  const result = { ...defaults, ...input };
  if (result.maxDepth > 256) throw new Error("Incoming snapshot: invalid-limits");
  return result;
}

export const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

export function fixture() {
  return {
    manifest: { name: "fixture", version: "1.0.0", dependencies: { alpha: "^1.0.0" } },
    lock: {
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0", dependencies: { alpha: "^1.0.0" } },
        "node_modules/alpha": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
          integrity,
        },
      } as Record<string, Record<string, unknown>>,
    },
  };
}

export function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function input(f = fixture()) {
  return {
    manifest: bytes(f.manifest),
    lockfile: bytes(f.lock),
    lockfileName: "package-lock.json" as const,
  };
}

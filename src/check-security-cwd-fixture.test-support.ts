import { chmodSync, copyFileSync, linkSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export function fakeNpmAudit(
  bin: string,
  target: string,
  shellBody: string,
  nodeBody: string,
): void {
  if (process.platform !== "win32") {
    mkdirSync(bin, { recursive: true });
    const npm = join(bin, "npm");
    writeFileSync(npm, `#!/bin/sh\n${shellBody}\n`);
    chmodSync(npm, 0o755);
    return;
  }
  const npm = join(bin, "npm.exe");
  try {
    linkSync(process.execPath, npm);
  } catch {
    copyFileSync(process.execPath, npm);
  }
  writeFileSync(join(target, "audit"), nodeBody);
}

export function npmPath(bin: string): string {
  return process.platform === "win32"
    ? `${bin}${delimiter}${process.env.PATH ?? ""}`
    : `${bin}:/usr/bin:/bin`;
}

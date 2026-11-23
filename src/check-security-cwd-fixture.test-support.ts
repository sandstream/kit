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

export function initNpmAuditTarget(target: string): void {
  writeFileSync(join(target, "package.json"), '{"name":"target","version":"1.0.0"}\n');
  writeFileSync(
    join(target, "package-lock.json"),
    '{"lockfileVersion":3,"packages":{"":{},"node_modules/demo":{"version":"1.0.0"}}}\n',
  );
}

export function writeNpmAuditCwdFixture(bin: string, target: string): void {
  const scanner = `
const high = require('node:fs').existsSync('.target-marker') ? 1 : 0;
const known = { name: 'demo', severity: 'high', via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-2222-3333-4444' }] };
process.stdout.write(JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: high ? { demo: known } : {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical: 0, total: high },
    dependencies: { total: 1 },
  },
}));
process.exit(high ? 1 : 0);`;
  const path = join(target, "audit-fixture.cjs");
  writeFileSync(path, scanner);
  fakeNpmAudit(bin, target, `exec "${process.execPath}" "${path}"`, scanner);
}

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { auditFixture } from "./audit-concurrency.test-support.js";
import type { Manager } from "./manager-audit-config.js";

export const yarnLock = `__metadata:
  version: 8

"fixture@workspace:.":
  version: 0.0.0-use.local
  resolution: "fixture@workspace:."
`;

const locks = {
  yarn: { file: "yarn.lock", text: yarnLock },
  pnpm: { file: "pnpm-lock.yaml", text: "lockfileVersion: '9.0'\nimporters:\n  .: {}\n" },
  bun: {
    file: "bun.lock",
    text: JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { name: "fixture" } },
      packages: {},
    }),
  },
};

export function managerFixture(t: TestContext, manager: Manager) {
  const fixture = auditFixture(t);
  // npm test can export its own config paths, which lie outside the fixture's scope.
  for (const name of Object.keys(fixture.env)) {
    if (/^(?:BUN_|PNPM_|YARN_|NPM_CONFIG_)/i.test(name)) delete fixture.env[name];
  }
  const { file, text } = locks[manager];
  const lockfile = join(fixture.project, file);
  writeFileSync(lockfile, text);
  writeFileSync(join(fixture.project, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  return { project: fixture.project, home: fixture.home, env: fixture.env, lockfile };
}

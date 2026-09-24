/** Synthetic fixtures shared by runner tests, not a production entry point. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MONKEY_ROLES } from "./monkey-test-contract.js";
import { writeMonkeyHarness } from "./monkey-test-harness.js";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function fixtureEnvironment(root: string): NodeJS.ProcessEnv {
  return { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, NODE_ENV: "test" };
}

export async function runnerFixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "kit-monkey-runtime-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      devDependencies: { "@playwright/test": "1.0.0" },
    }),
  );
  const playwright = join(root, "node_modules", "@playwright", "test");
  mkdirSync(playwright, { recursive: true });
  writeFileSync(join(playwright, "package.json"), JSON.stringify({ main: "index.js" }));
  writeFileSync(join(playwright, "index.js"), "module.exports = {};\n");
  await writeMonkeyHarness(root);
  writeFileSync(
    join(root, ".kit/monkey-test/role-matrix.json"),
    JSON.stringify({
      configured: true,
      roles: MONKEY_ROLES.map(({ id }) => ({
        id,
        allowRoutes: ["/"],
        denyRoutes: [`/denied-${id}`],
        requiredText: [`own-${id}`],
        forbiddenText: [`other-${id}`],
      })),
    }),
  );
  mkdirSync(join(root, "home"));
  return root;
}

export function fixtureCommand(root: string, name: string, source: string): string {
  writeFileSync(join(root, `${name}.mjs`), source);
  return `${shellQuote(process.execPath)} ${shellQuote(`${name}.mjs`)}`;
}

export function markerCommand(root: string, name: string): string {
  return fixtureCommand(
    root,
    name,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(`${name}.ran`)}, "yes");`,
  );
}

export function serverCommand(root: string): string {
  return fixtureCommand(
    root,
    "server",
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const server = createServer((_request, response) => response.end("ok"));
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  writeFileSync("server.ran", "yes");
  writeFileSync("server.pid", String(process.pid));
});`,
  );
}

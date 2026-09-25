/** Synthetic fixtures shared by runner tests, not a production entry point. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { MONKEY_ROLES } from "./monkey-test-contract.js";
import { writeMonkeyHarness } from "./monkey-test-harness.js";

export function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function fixtureEnvironment(root: string): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  const paths = [
    dirname(process.execPath),
    ...(windows
      ? process.env.SystemRoot
        ? [join(process.env.SystemRoot, "System32")]
        : []
      : ["/usr/bin", "/bin"]),
  ];
  return {
    HOME: root,
    PATH: paths.join(delimiter),
    NODE_ENV: "test",
    ...(windows
      ? {
          ComSpec: process.env.ComSpec,
          SystemRoot: process.env.SystemRoot,
          USERPROFILE: root,
          PATHEXT: process.env.PATHEXT,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        }
      : {}),
  };
}

/** Keep in-process runner tests independent of the host's CI and developer env. */
export async function withFixtureEnvironment<T>(root: string, run: () => Promise<T>): Promise<T> {
  const original = { ...process.env };
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const fixture = {
    ...fixtureEnvironment(home),
    KIT_NON_INTERACTIVE: "1",
    KIT_BUMBLEBEE: "0",
    KIT_NO_FAILURE_SIM: "1",
    KIT_NO_UPDATE_CHECK: "1",
    KIT_AUDIT_ANCHOR: "0",
  };
  const replace = (values: NodeJS.ProcessEnv): void => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
  };
  replace(fixture);
  try {
    return await run();
  } finally {
    replace(original);
  }
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

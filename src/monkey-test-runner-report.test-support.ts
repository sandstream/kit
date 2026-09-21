/** Synthetic reporter output for runner evidence and redaction tests. */
import { MONKEY_ROLES } from "./monkey-test-contract.js";
import { fixtureCommand } from "./monkey-test-runner.test-support.js";

export const OUTPUT_SECRET = "synthetic-runner-secret-value-123456789";

function passingTests() {
  return ["desktop-chromium", "mobile-chrome"].map((projectName) => ({
    projectName,
    expectedStatus: "passed",
    status: "expected",
    results: [{ status: "passed" }],
  }));
}

const suites = [
  ...MONKEY_ROLES.map(({ id, label }) => ({
    title: `${id}: ${label}`,
    specs: [{ title: "route crawl", tests: passingTests() }],
  })),
  { title: "customer payment", specs: [{ title: "money flow", tests: passingTests() }] },
];

export function noisyCommand(root: string, name: string, exitCode = 0): string {
  const reportSource =
    name === "test"
      ? `writeFileSync(".kit/monkey-test/playwright-report.json", JSON.stringify({
  config: { metadata: { kitMonkeyContract: 1, kitMonkeyRunId: process.env.MONKEY_RUN_ID } },
  suites: ${JSON.stringify(suites)}, errors: [],
}));`
      : "";
  return fixtureCommand(
    root,
    name,
    `import { writeFileSync } from "node:fs";
${reportSource}
process.stdout.write(${JSON.stringify(`${name} stdout\n`)});
process.stderr.write(${JSON.stringify(`${name} stderr\n`)});
const secret = process.env.MONKEY_TEST_SECRET;
process.stdout.write(${JSON.stringify(`${name} partial `)} + secret.slice(0, 12));
setTimeout(() => {
  process.stdout.write(secret.slice(12));
  process.exitCode = ${exitCode};
}, 20);`,
  );
}

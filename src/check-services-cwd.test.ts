import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceStatus } from "./check-services.js";

type ProbeEntry = "services" | "gate";
interface ProbeOptions {
  domain?: "caller" | "governed";
  generic?: boolean;
  omitCwd?: boolean;
}

function prepareProjects(dir: string, generic = false) {
  const caller = join(dir, "caller");
  const governed = join(dir, "governed");
  const bin = join(dir, "bin");
  const cwdLog = join(dir, "probe-cwd.txt");
  for (const path of [caller, governed, bin]) mkdirSync(path);
  for (const [path, domain] of [
    [caller, "caller"],
    [governed, "governed"],
  ]) {
    writeFileSync(
      join(path, ".infisical.json"),
      JSON.stringify({ domain: `https://${domain}.test` }),
    );
  }
  const command = generic
    ? "health-check status"
    : "infisical login status --json --silent --telemetry=false";
  writeFileSync(
    join(governed, ".kit.toml"),
    `[services.vault]\nlogin = ""\ncheck = ${JSON.stringify(command)}\n`,
  );
  return { caller, governed, bin, cwdLog, command };
}

function prepareCli(bin: string, cwdLog: string, domain = "governed") {
  const executable = (name: string, source: string) => {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  };
  executable("mise", "process.exitCode = 1;");
  executable(
    "which",
    `console.log(require("node:path").join(${JSON.stringify(bin)}, process.argv[2]));`,
  );
  const recordCwd = `require("node:fs").writeFileSync(${JSON.stringify(cwdLog)}, process.cwd());`;
  executable("health-check", `${recordCwd}\nconsole.log(process.cwd());`);
  const status = JSON.stringify({
    sessions: [
      {
        tokenSource: "infisical login (keyring)",
        domain: `https://${domain}.test`,
        status: "authenticated",
        verification: { state: "verified" },
      },
    ],
  });
  executable(
    "infisical",
    `
        if (JSON.stringify(process.argv.slice(2)) !== '["login","status","--json","--silent","--telemetry=false"]') {
          throw new Error("Only the read-only status fixture is permitted");
        }
        ${recordCwd}
        console.log(${JSON.stringify(status)});
      `,
  );
}

function runProbe(
  entry: ProbeEntry,
  fixture: ReturnType<typeof prepareProjects>,
  omitCwd = false,
): { services: ServiceStatus[]; ok: boolean } {
  const { caller, governed, bin, command } = fixture;
  const sourceMode = import.meta.url.endsWith(".ts");
  const moduleUrl = new URL(
    `./${entry === "gate" ? "check-run" : "check-services"}.${sourceMode ? "ts" : "js"}`,
    import.meta.url,
  ).href;
  const source =
    entry === "gate"
      ? `
          import { runCheckGate } from ${JSON.stringify(moduleUrl)};
          const { services, ok } = await runCheckGate({ cwd: ${JSON.stringify(governed)}, categories: ["services"] });
          console.log(JSON.stringify({ services, ok }));
        `
      : `
          import { checkServices } from ${JSON.stringify(moduleUrl)};
          const services = await checkServices({ vault: { login: "", check: ${JSON.stringify(command)} } }${omitCwd ? "" : `, ${JSON.stringify(governed)}`});
          console.log(JSON.stringify({ services, ok: services.every(s => s.authenticated) }));
        `;
  const stdout = execFileSync(
    process.execPath,
    [
      ...(sourceMode ? ["--import", import.meta.resolve("tsx")] : []),
      "--input-type=module",
      "-e",
      source,
    ],
    {
      cwd: caller,
      // Neither operator credentials nor real service executables enter this fixture.
      env: { PATH: bin },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  return JSON.parse(stdout);
}

function probe(
  entry: ProbeEntry,
  options: ProbeOptions = {},
): { services: ServiceStatus[]; ok: boolean; probeCwd: string; governed: string; caller: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-services-cwd-")));
  try {
    const fixture = prepareProjects(dir, options.generic);
    const { caller, governed, bin, cwdLog } = fixture;
    prepareCli(bin, cwdLog, options.domain);
    return {
      ...runProbe(entry, fixture, options.omitCwd),
      probeCwd: readFileSync(cwdLog, "utf8"),
      governed,
      caller,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("service checks honor the governed cwd", () => {
  for (const entry of ["services", "gate"] as const) {
    it(`${entry}: rejects a verified session bound only to the caller's domain`, () => {
      const result = probe(entry, { domain: "caller" });
      assert.equal(result.services[0].authenticated, false);
      assert.equal(result.ok, false);
      assert.match(result.services[0].output, /does not match the configured domain/);
      assert.equal(result.probeCwd, result.governed);
    });

    it(`${entry}: accepts a verified session bound to the governed project`, () => {
      const result = probe(entry);
      assert.equal(result.services[0].authenticated, true);
      assert.equal(result.ok, true);
      assert.equal(result.probeCwd, result.governed);
    });

    it(`${entry}: executes arbitrary service checks in the governed project`, () => {
      const result = probe(entry, { generic: true });
      assert.equal(result.services[0].authenticated, true);
      assert.equal(result.services[0].output, result.governed);
      assert.equal(result.probeCwd, result.governed);
    });
  }

  it("keeps process.cwd() as the default for existing direct callers", () => {
    const result = probe("services", { domain: "caller", omitCwd: true });
    assert.equal(result.services[0].authenticated, true);
    assert.equal(result.probeCwd, result.caller);
  });
});

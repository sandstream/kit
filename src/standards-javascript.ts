import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneralScan } from "./check-standards.js";
import { execFileNoThrow, failedDetail } from "./utils/execFileNoThrow.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import {
  readJavaScriptInputs,
  sameJavaScriptInputs,
  type JavaScriptInput,
} from "./standards-javascript-files.js";
import { readJavaScriptReport, TYPESCRIPT_TOOL_VERSIONS } from "./standards-javascript-report.js";

export type JavaScriptScan = GeneralScan["complexity"] & {
  files: string[];
  engineVersion?: string;
};

async function compilerTool(): Promise<{ api: string; version: string }> {
  const bin = await resolveToolBin("tsc");
  if (!bin) throw new Error("JavaScript analysis requires a provisioned TypeScript compiler tool");
  const executable = realpathSync(bin);
  const root = dirname(dirname(executable));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (
    manifest.name !== "typescript" ||
    !TYPESCRIPT_TOOL_VERSIONS.has(manifest.version) ||
    executable !== join(root, "bin", "tsc")
  ) {
    throw new Error(
      "JavaScript analysis requires a supported canonical TypeScript compiler installation",
    );
  }
  const api = realpathSync(join(root, "lib", "typescript.js"));
  if (api !== join(root, "lib", "typescript.js")) {
    throw new Error("TypeScript compiler API leaves its declared installation");
  }
  return { api, version: manifest.version };
}

function parserEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
  };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "Path"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function measure(inputs: JavaScriptInput[]): Promise<JavaScriptScan> {
  const compiler = await compilerTool();
  const temporary = mkdtempSync(join(tmpdir(), "kit-standards-javascript-"));
  try {
    const input = join(temporary, "request.json");
    writeFileSync(input, JSON.stringify({ version: 1, files: inputs }), { mode: 0o600 });
    const worker = fileURLToPath(new URL("./standards-javascript-worker.js", import.meta.url));
    const result = await execFileNoThrow(process.execPath, [worker, compiler.api, input], {
      cwd: temporary,
      env: parserEnvironment(temporary),
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!result.ok || result.truncated || result.timedOut) {
      throw new Error(failedDetail("JavaScript parser did not complete", result));
    }
    return {
      findings: readJavaScriptReport(result.stdout, inputs, compiler.version),
      didNotRun: false,
      files: inputs.map((file) => file.path),
      engineVersion: compiler.version,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Measure complete JavaScript/TypeScript inputs without executing their code or project configuration. */
export async function scanJavaScript(cwd: string): Promise<JavaScriptScan> {
  let inputs: JavaScriptInput[] = [];
  try {
    inputs = await readJavaScriptInputs(cwd);
    if (!inputs.length) return { findings: [], didNotRun: false, files: [] };
    const scan = await measure(inputs);
    if (!sameJavaScriptInputs(inputs, await readJavaScriptInputs(cwd))) {
      throw new Error("JavaScript sources changed during analysis");
    }
    return scan;
  } catch {
    // Parser output and filesystem errors can contain source text or private paths.
    return {
      findings: [],
      didNotRun: true,
      files: inputs.map((file) => file.path),
      issue:
        "JavaScript/TypeScript analysis is incomplete. Check the supported compiler tool, source access and parse validity. No Lizard fallback was used.",
    };
  }
}

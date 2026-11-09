import {
  loadCompiler,
  readRequest,
  type WorkerOutput,
} from "./standards-javascript-worker-protocol.js";
import { measureFile } from "./standards-javascript-worker-metrics.js";
import { calibrate } from "./standards-javascript-worker-calibration.js";

const output: WorkerOutput = {
  version: 1,
  engine: { name: "typescript", version: "unknown" },
  metricVersion: "kit-js-ccn/v1",
  calibration: false,
  complete: false,
  files: [],
};

try {
  if (process.argv.length !== 4) throw new Error("Expected compiler and request paths");
  const compiler = loadCompiler(process.argv[2]);
  output.engine.version = compiler.version;
  output.calibration = calibrate(compiler);
  if (!output.calibration) throw new Error("Compiler calibration failed");
  const inputs = readRequest(process.argv[3]);
  output.files = inputs.map((input) => measureFile(compiler, input));
  output.complete = output.files.every((file) => file.status === "complete");
} catch {
  // A failed batch has no partial success claim. Never print source text or exception details.
  output.complete = false;
}

process.stdout.write(JSON.stringify(output) + "\n");
process.exitCode = output.complete ? 0 : 1;

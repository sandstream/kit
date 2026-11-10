import type { Compiler, WorkerFile } from "./standards-javascript-worker-protocol.js";
import { measureFile } from "./standards-javascript-worker-metrics.js";

interface CalibrationCase {
  path: string;
  text: string;
  expected: [string, number][];
}

const CASES: CalibrationCase[] = [
  {
    path: "calibration.js",
    text: "function decide(flag) {\n const env = { ...one(), ...two(JSON.parse(json)) };\n if(flag) return 'yes';\n return 'no';\n}",
    expected: [
      ["<module>", 1],
      ["decide", 2],
    ],
  },
  {
    path: "calibration.ts",
    text: "type Pick<T> = T extends number ? (() => void) : never;\nfunction outer(value: number = 1): number {\n const inner = (x: number = 0): number => x ? 1 : 0;\n if(value) return inner(value);\n return 0;\n}",
    expected: [
      ["<module>", 1],
      ["outer", 3],
      ["inner", 3],
    ],
  },
  {
    path: "calibration.tsx",
    text: "class C extends (flag ? A : B) {\n [key || 'm'](x = 0) { return x?.value; }\n field = ready && (() => <b>{ok ? 'a' : 'b'}</b>);\n static { if (ready) go(); }\n}",
    expected: [
      ["<module>", 3],
      ["[computed]", 3],
      ["field", 2],
      ["(anonymous@94)", 2],
      ["static block", 2],
    ],
  },
];

function matches(result: WorkerFile, fixture: CalibrationCase): boolean {
  if (result.status !== "complete" || result.bodies.length !== fixture.expected.length)
    return false;
  return fixture.expected.every(([name, ccn]) =>
    result.bodies.some(
      (body) => body.name === name && body.ccn === ccn && body.ccn === body.decisions.length + 1,
    ),
  );
}

/** Calibration is a compatibility check, not proof that a requested file was fully measured. */
export function calibrate(api: Compiler): boolean {
  for (const fixture of CASES) {
    const result = measureFile(api, {
      path: fixture.path,
      text: fixture.text,
      sha256: "calibration",
    });
    if (!matches(result, fixture)) return false;
    if (result.bodies.find((body) => body.kind === "module")?.end !== fixture.text.length)
      return false;
    if (fixture.path === "calibration.js") {
      const body = result.bodies.find((body) => body.name === "decide");
      if (body?.end !== fixture.text.length || body.length !== 5) return false;
    }
  }
  const invalid = measureFile(api, {
    path: "invalid.ts",
    text: "function broken( {",
    sha256: "calibration",
  });
  return invalid.status === "invalid" && invalid.diagnostics.length > 0;
}

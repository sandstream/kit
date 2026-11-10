import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import type * as TypeScript from "typescript";

export type Compiler = typeof TypeScript;
export interface WorkerInput {
  path: string;
  text: string;
  sha256: string;
}
export interface BodyMetric {
  id: string;
  name: string;
  kind: "function" | "module" | "initializer" | "static-block";
  /** UTF-16 offsets. The end offset is exclusive. */
  start: number;
  end: number;
  ccn: number;
  /** Inclusive physical lines from start through the last occupied character. */
  length: number;
  decisions: number[];
}
export interface WorkerFile {
  path: string;
  sha256: string;
  status: "complete" | "invalid";
  bodies: BodyMetric[];
  diagnostics: { start: number; length: number; code: number }[];
}
export interface WorkerOutput {
  version: 1;
  engine: { name: "typescript"; version: string };
  metricVersion: "kit-js-ccn/v1";
  calibration: boolean;
  complete: boolean;
  files: WorkerFile[];
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validFile(value: unknown): value is WorkerInput {
  if (!exactObject(value, ["path", "text", "sha256"])) return false;
  if (typeof value.path !== "string" || !value.path || value.path.includes("\0")) return false;
  if (typeof value.text !== "string" || typeof value.sha256 !== "string") return false;
  return (
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    createHash("sha256").update(value.text, "utf8").digest("hex") === value.sha256
  );
}

export function readRequest(path: string): WorkerInput[] {
  if (!isAbsolute(path)) throw new Error("Request path must be absolute");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!exactObject(value, ["version", "files"]) || value.version !== 1) {
    throw new Error("Invalid request envelope");
  }
  if (!Array.isArray(value.files) || !value.files.every(validFile)) {
    throw new Error("Invalid request files");
  }
  if (new Set(value.files.map((file) => file.path)).size !== value.files.length) {
    throw new Error("Duplicate request paths");
  }
  return value.files;
}

export function loadCompiler(path: string): Compiler {
  if (!isAbsolute(path)) throw new Error("Compiler path must be absolute");
  // The parent validates provenance. Never search the inspected project's module tree.
  const api: Compiler = createRequire(import.meta.url)(path);
  if (!["5.9.3", "6.0.3"].includes(api?.version)) throw new Error("Unsupported compiler");
  const methods = [
    "createSourceFile",
    "forEachChild",
    "isTypeNode",
    "isFunctionLike",
    "isClassStaticBlockDeclaration",
    "isPropertyDeclaration",
    "isBinaryExpression",
  ] as const;
  if (methods.some((method) => typeof api[method] !== "function")) {
    throw new Error("Incomplete compiler API");
  }
  if (!api.ScriptKind || !api.ScriptTarget || !api.SyntaxKind) {
    throw new Error("Missing compiler syntax tables");
  }
  return api;
}

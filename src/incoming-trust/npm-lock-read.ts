import type { NpmLockInventory, NpmLockIssue } from "./npm-lock.js";
import { parseJsonObject } from "../utils/json-object.js";

export const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export type JsonRecord = Record<string, unknown>;
export interface Reader {
  result: NpmLockInventory;
  file: NpmLockIssue["file"];
}

export function issue(
  reader: Reader,
  code: NpmLockIssue["code"],
  path: string,
  message: string,
): void {
  reader.result.completeness.status = "incomplete";
  reader.result.issues.push({ code, file: reader.file, path, message });
}

export function pointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function object(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readObject(bytes: Uint8Array, reader: Reader): JsonRecord | null {
  const result = parseJsonObject(bytes, 16 * 1024 * 1024);
  if ("issues" in result) {
    for (const entry of result.issues) issue(reader, entry.code, "", entry.message);
    return null;
  }
  return result.value;
}

export function stringMap(value: unknown, reader: Reader, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value)) {
    issue(reader, "invalid-schema", path, "Expected an object with string values.");
    return {};
  }
  const entries: [string, string][] = [];
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === "string") entries.push([name, spec]);
    else issue(reader, "invalid-schema", `${path}/${pointer(name)}`, "Expected a string value.");
  }
  return Object.fromEntries(entries);
}

export function validateFields(value: JsonRecord, reader: Reader, path: string): void {
  if (typeof value.name === "string" && !packageName(value.name)) {
    issue(reader, "invalid-schema", `${path}/name`, "Expected a package name.");
  }
  for (const field of ["name", "version", "resolved", "integrity"]) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || value[field].trim() === "")
    ) {
      issue(reader, "invalid-schema", `${path}/${field}`, "Expected a string value.");
    }
  }
  for (const field of [
    "link",
    "hasInstallScript",
    "dev",
    "optional",
    "devOptional",
    "inBundle",
    "hasShrinkwrap",
  ]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      issue(reader, "invalid-schema", `${path}/${field}`, "Expected a boolean value.");
    }
  }
}

export function readEdges(value: JsonRecord, from: string, reader: Reader, path: string): void {
  const peers = optionalPeers(value.peerDependenciesMeta, reader, `${path}/peerDependenciesMeta`);
  for (const section of dependencySections) {
    const entries = stringMap(value[section], reader, `${path}/${section}`);
    for (const [name, spec] of Object.entries(entries)) {
      if (!packageName(name) || spec.trim() === "") {
        issue(
          reader,
          "invalid-schema",
          `${path}/${section}/${pointer(name)}`,
          "Expected a package name and a nonempty dependency specification.",
        );
      }
      const optional =
        section === "optionalDependencies" ||
        (object(value.optionalDependencies) && Object.hasOwn(value.optionalDependencies, name)) ||
        (section === "peerDependencies" && peers.has(name));
      reader.result.edges.push({ from, section, name, spec, optional });
    }
  }
}

export function optionalPeers(value: unknown, reader: Reader, path: string): Set<string> {
  const optional = new Set<string>();
  if (value === undefined) return optional;
  if (!object(value)) {
    issue(reader, "invalid-schema", path, "Expected peer dependency metadata.");
    return optional;
  }
  for (const [name, meta] of Object.entries(value)) {
    if (!object(meta) || (meta.optional !== undefined && typeof meta.optional !== "boolean")) {
      issue(
        reader,
        "invalid-schema",
        `${path}/${pointer(name)}`,
        "Expected peer metadata with a boolean optional field.",
      );
    } else if (meta.optional === true) optional.add(name);
  }
  return optional;
}

export function packageName(name: string): boolean {
  return (
    /^(?:@[a-zA-Z0-9_~.-]+\/)?[a-zA-Z0-9_~.-]+$/.test(name) &&
    name.split("/").every((part) => part !== "." && part !== "..")
  );
}

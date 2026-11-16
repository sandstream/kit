import {
  dependencySections,
  issue,
  object,
  packageName,
  pointer,
  text,
  type JsonRecord,
  type Reader,
} from "./npm-lock-read.js";

import { relativePath } from "./npm-lock-workspaces.js";

function sameDeclarations(left: unknown, right: unknown): boolean {
  const a = left === undefined ? {} : left;
  const b = right === undefined ? {} : right;
  if (!object(a) || !object(b)) return false;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && b[key] === value)
  );
}

export function rootConsistency(manifest: JsonRecord, lock: JsonRecord, reader: Reader): void {
  if (!object(lock.packages) || !object(lock.packages[""])) return;
  const root = lock.packages[""];
  for (const field of ["name", "version"]) {
    for (const [record, path] of [
      [root, "/packages/"],
      [lock, ""],
    ] as const) {
      if (text(manifest[field]) !== text(record[field])) {
        issue(
          reader,
          "root-identity-mismatch",
          `${path}/${field}`,
          "Root identity differs from the supplied manifest.",
        );
      }
    }
  }
  if (peerOptionals(manifest.peerDependenciesMeta) !== peerOptionals(root.peerDependenciesMeta)) {
    issue(
      reader,
      "root-dependency-mismatch",
      "/packages//peerDependenciesMeta",
      "Root optional peer declarations differ from the supplied manifest.",
    );
  }
  for (const section of dependencySections) {
    if (!sameDeclarations(manifest[section], root[section])) {
      issue(
        reader,
        "root-dependency-mismatch",
        `/packages//${section}`,
        "Root dependency declarations differ from the supplied manifest.",
      );
    }
  }
}

function dependencyTarget(from: string, name: string, records: JsonRecord): JsonRecord | null {
  let directory = from;
  while (true) {
    const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`;
    if (
      !directory.endsWith("/node_modules") &&
      directory !== "node_modules" &&
      Object.hasOwn(records, candidate)
    ) {
      return object(records[candidate]) ? records[candidate] : null;
    }
    if (!directory) return null;
    const slash = directory.lastIndexOf("/");
    directory = slash < 0 ? "" : directory.slice(0, slash);
  }
}

export function dependencyConsistency(lock: JsonRecord, reader: Reader): void {
  if (!object(lock.packages)) return;
  for (const edge of reader.result.edges) {
    if (!packageName(edge.name) || (edge.from !== "" && !relativePath(edge.from))) continue;
    const target = dependencyTarget(edge.from, edge.name, lock.packages);
    const at = `/packages/${pointer(edge.from)}/${edge.section}/${pointer(edge.name)}`;
    if (!target) {
      if (edge.optional) continue;
      issue(
        reader,
        "missing-dependency-target",
        at,
        "No package record resolves this dependency declaration.",
      );
      continue;
    }
    const alias = /^npm:((?:@[^/]+\/)?[^@]+)@/.exec(edge.spec);
    const expected = alias?.[1] ?? edge.name;
    if (typeof target.name === "string" && target.name !== expected) {
      issue(
        reader,
        "dependency-identity-mismatch",
        at,
        "The declared dependency identity differs from its package record.",
      );
    }
  }
}

function peerOptionals(value: unknown): string {
  if (!object(value)) return "[]";
  return JSON.stringify(
    Object.entries(value)
      .filter(([, meta]) => object(meta) && meta.optional === true)
      .map(([name]) => name)
      .sort(),
  );
}

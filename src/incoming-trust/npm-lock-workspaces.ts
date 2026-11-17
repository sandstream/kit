import { issue, object, pointer, type JsonRecord, type Reader } from "./npm-lock-read.js";

/** Accept only canonical, root-relative POSIX paths. Do not decode or normalize input. */
export function relativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    path.split("/").length <= 128 &&
    !/[\\:%\x00-\x1f\x7f?#]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function packagePath(path: string, reader: Reader): void {
  if (path !== "" && (!relativePath(path) || /[*[\]{}!]/.test(path))) {
    issue(
      reader,
      "invalid-package-path",
      `/packages/${pointer(path)}`,
      "Package location must stay inside the project with a canonical relative path.",
    );
  }
}

export function linkPath(path: string, target: string | null, reader: Reader): void {
  reader.result.links.push({ path, target });
  if (target === null || !relativePath(target) || /[*[\]{}!]/.test(target)) {
    issue(
      reader,
      "invalid-link-path",
      `/packages/${pointer(path)}/resolved`,
      "Link target must stay inside the project with a canonical relative path.",
    );
  }
}

function workspacePatterns(value: unknown, reader: Reader, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((p) => typeof p !== "string")) {
    issue(reader, "invalid-schema", path, "Expected an array of workspace path patterns.");
    return [];
  }
  if (value.length > 128) {
    issue(reader, "input-limit", path, "Workspace declarations are limited to 128 patterns.");
    return [];
  }
  for (const pattern of value) {
    if (!relativePath(pattern))
      issue(
        reader,
        "invalid-workspace-path",
        path,
        "Workspace paths must stay inside the project.",
      );
    if (pattern.split("/").some((part: string) => part !== "*" && /[*[\]{}!]|[@+]\(/.test(part))) {
      issue(
        reader,
        "unsupported-workspace-pattern",
        path,
        "Only literal paths and whole-segment stars are supported.",
      );
    }
  }
  return value;
}

function matches(path: string, pattern: string): boolean {
  const parts = pattern.split("/");
  const actual = path.split("/");
  return (
    parts.length === actual.length && parts.every((part, i) => part === "*" || part === actual[i])
  );
}

export function workspaces(manifest: JsonRecord | null, lock: JsonRecord, reader: Reader): void {
  const root = object(lock.packages) && object(lock.packages[""]) ? lock.packages[""] : {};
  const patterns = workspacePatterns(
    manifest?.workspaces,
    { ...reader, file: "package.json" },
    "/workspaces",
  );
  const locked = workspacePatterns(root.workspaces, reader, "/packages//workspaces");
  reader.result.workspaces.patterns = patterns;
  if (JSON.stringify(patterns) !== JSON.stringify(locked)) {
    issue(
      reader,
      "workspace-mismatch",
      "/packages//workspaces",
      "Workspace declarations differ from the supplied manifest.",
    );
  }
  if (!object(lock.packages)) return;
  for (const pattern of patterns) {
    if (!pattern.includes("*") && !Object.hasOwn(lock.packages, pattern)) {
      issue(
        reader,
        "missing-workspace-record",
        "/packages",
        "A declared literal workspace has no package record.",
      );
    }
  }
  reader.result.workspaces.packages = Object.keys(lock.packages).filter(
    (path) =>
      path !== "" &&
      !path.split("/").includes("node_modules") &&
      patterns.some((p) => matches(path, p)),
  );
}

export function validateLinks(lock: JsonRecord, reader: Reader): void {
  if (!object(lock.packages)) return;
  for (const link of reader.result.links) {
    const at = `/packages/${pointer(link.path)}`;
    const record = lock.packages[link.path];
    if (object(record) && Object.keys(record).some((k) => !["link", "resolved"].includes(k))) {
      issue(
        reader,
        "invalid-link-record",
        at,
        "Link records may contain only link and resolved fields.",
      );
    }
    if (!link.target || !relativePath(link.target)) continue;
    const target = Object.hasOwn(lock.packages, link.target) ? lock.packages[link.target] : null;
    if (!object(target)) {
      issue(reader, "missing-link-target", `${at}/resolved`, "Link target has no package record.");
    } else if (target.link === true || link.target.split("/").includes("node_modules")) {
      issue(
        reader,
        "unsupported-link-target",
        `${at}/resolved`,
        "Link chains and installed-package targets are not supported.",
      );
    }
  }
}

export function workspaceRecord(raw: JsonRecord, path: string, reader: Reader): boolean {
  if (typeof raw.name !== "string" || raw.name === "") {
    issue(
      reader,
      "missing-package-identity",
      `/packages/${pointer(path)}`,
      "Workspace records need an explicit package name.",
    );
  }
  const conflicting = ["resolved", "integrity", "link", "inBundle"].some((key) =>
    Object.hasOwn(raw, key),
  );
  if (conflicting) {
    issue(
      reader,
      "invalid-workspace-record",
      `/packages/${pointer(path)}`,
      "Workspace records cannot replace fetched artifact or link records.",
    );
  }
  return !conflicting;
}

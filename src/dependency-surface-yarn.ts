/**
 * Read a `yarn.lock` into the graph `dependency-surface.ts` analyses.
 *
 * Both formats are read by hand, because kit takes in no YAML library: the classic format (version 1,
 * `name "range"` lines) and the berry format (version 2 and later, `name: range` lines). The files
 * are regular enough for that, and a text that is neither is refused rather than guessed at.
 *
 * A yarn lockfile has no `dev` flag, no `engines` and no install-script data. A package is
 * development only when no runtime dependency of the project reaches it, and the graph says which
 * facts it cannot give, so the rules that need them do not run and are not read as clean.
 */
import type { DepGraph, GraphNode, ProjectManifest } from "./dependency-surface.js";

export interface YarnEntry {
  /** Every `name@range` this entry answers, as written in the lockfile. */
  descriptors: string[];
  name: string;
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, "$1");

/** The package name in a `name@range` descriptor. A scoped name starts with `@`. */
function descriptorName(descriptor: string): string {
  const at = descriptor.indexOf("@", 1);
  return at > 0 ? descriptor.slice(0, at) : descriptor;
}

/**
 * Split a block header into its descriptors. Berry quotes the whole list as one string
 * (`"a@npm:^1, a@npm:^2":`), classic quotes each descriptor on its own (`"a@^1", a@^2:`).
 */
function headerDescriptors(line: string): string[] {
  const header = line.replace(/:\s*$/, "").trim();
  const wholeString = /^"[^"]*"$/.test(header);
  const parts = wholeString ? header.slice(1, -1).split(",") : header.split(",");
  return parts.map(unquote).filter((d) => d.length > 0);
}

/** One `key value` (classic) or `key: value` (berry) line inside a dependency section. */
function keyValue(line: string, berry: boolean): [string, string] | null {
  const m = berry
    ? /^\s*("[^"]+"|[^\s:]+)\s*:\s*(.*)$/.exec(line)
    : /^\s*("[^"]+"|[^\s]+)\s+(.*)$/.exec(line);
  return m ? [unquote(m[1]), unquote(m[2])] : null;
}

type Section = "dependencies" | "optionalDependencies" | null;

function applyLine(
  entry: YarnEntry,
  line: string,
  state: { section: Section },
  berry: boolean,
): void {
  const indent = line.length - line.trimStart().length;
  const text = line.trim();
  if (indent <= 2) {
    state.section = null;
    const dep = /^(dependencies|optionalDependencies):\s*$/.exec(text);
    if (dep) {
      state.section = dep[1] as Section;
      return;
    }
    const version = berry ? /^version:\s*(.+)$/.exec(text) : /^version\s+(.+)$/.exec(text);
    if (version) entry.version = unquote(version[1]);
    if (/^resolution:.*@workspace:/.test(text)) entry.version = "workspace";
    return;
  }
  if (!state.section) return;
  const kv = keyValue(line, berry);
  if (kv) entry[state.section][kv[0]] = kv[1];
}

/** Parse a yarn lockfile (classic or berry). Null when the text is neither. */
export function parseYarnLock(text: string): YarnEntry[] | null {
  const berry = /^__metadata:/m.test(text);
  if (!berry && !/yarn lockfile v1/.test(text)) return null;
  const entries: YarnEntry[] = [];
  let current: YarnEntry | null = null;
  const state: { section: Section } = { section: null };
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = null;
      if (!line.trimEnd().endsWith(":") || line.startsWith("__metadata")) continue;
      const descriptors = headerDescriptors(line);
      if (descriptors.length === 0) continue;
      current = {
        descriptors,
        name: descriptorName(descriptors[0]),
        version: "",
        dependencies: {},
        optionalDependencies: {},
      };
      state.section = null;
      entries.push(current);
      continue;
    }
    if (current) applyLine(current, line, state, berry);
  }
  // The project itself (berry's `workspace:` entries) is not a package it depends on.
  return entries.filter((e) => e.version !== "workspace" && e.version !== "");
}

function resolveDescriptor(
  byDescriptor: Map<string, YarnEntry>,
  name: string,
  range: string,
): YarnEntry | undefined {
  return (
    byDescriptor.get(`${name}@${range}`) ??
    byDescriptor.get(`${name}@npm:${range}`) ??
    byDescriptor.get(`${name}@${range.replace(/^npm:/, "")}`)
  );
}

/** Mark as development only every node that no runtime dependency of the project reaches. */
function markDevOnly(nodes: Map<string, GraphNode>, runtimeRoots: string[]): void {
  const reached = new Set<string>();
  const stack = [...runtimeRoots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) stack.push(dep);
  }
  for (const node of nodes.values()) node.dev = !reached.has(node.id);
}

function keepReachable(nodes: Map<string, GraphNode>, roots: string[]): void {
  const reached = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) stack.push(dep);
  }
  for (const id of [...nodes.keys()]) if (!reached.has(id)) nodes.delete(id);
}

/** Turn a yarn lockfile into a graph. Null when the text is not a yarn lockfile. */
export function graphFromYarnLock(text: string, manifest: ProjectManifest): DepGraph | null {
  const entries = parseYarnLock(text);
  if (!entries) return null;
  const byDescriptor = new Map<string, YarnEntry>();
  for (const entry of entries) for (const d of entry.descriptors) byDescriptor.set(d, entry);
  const idOf = (e: YarnEntry): string => `${e.name}@${e.version}`;

  const nodes = new Map<string, GraphNode>();
  for (const entry of entries) {
    if (nodes.has(idOf(entry))) continue;
    const wanted = { ...entry.dependencies, ...entry.optionalDependencies };
    const deps = Object.entries(wanted)
      .map(([name, range]) => resolveDescriptor(byDescriptor, name, range))
      .filter((e): e is YarnEntry => e !== undefined)
      .map(idOf);
    nodes.set(idOf(entry), {
      id: idOf(entry),
      name: entry.name,
      version: entry.version,
      dev: false,
      deps,
      bins: [],
      hasInstallScript: false,
      platformOnly: false,
    });
  }

  const direct = new Map<string, string>();
  const runtimeRoots: string[] = [];
  const declared: [string, string, boolean][] = [
    ...Object.entries(manifest.dependencies ?? {}).map(([n, r]): [string, string, boolean] => [
      n,
      r,
      true,
    ]),
    ...Object.entries(manifest.devDependencies ?? {}).map(([n, r]): [string, string, boolean] => [
      n,
      r,
      false,
    ]),
  ];
  for (const [name, range, runtime] of declared) {
    const entry = resolveDescriptor(byDescriptor, name, range);
    if (!entry) continue;
    direct.set(name, idOf(entry));
    if (runtime) runtimeRoots.push(idOf(entry));
  }
  markDevOnly(nodes, runtimeRoots);
  // A monorepo lockfile also holds the packages of its other members. Keep only what this project
  // reaches, or those would be counted as its development-only weight.
  keepReachable(nodes, [...direct.values()]);
  return { nodes, direct, cannotSee: ["engines", "install scripts"] };
}

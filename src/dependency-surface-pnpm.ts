/**
 * Read a `pnpm-lock.yaml` into the graph `dependency-surface.ts` analyses.
 *
 * kit takes in no YAML library, so this reads the part of YAML that pnpm writes: nested maps, quoted
 * keys, one-line `{a: b}` maps and `[a, b]` lists, comments. A text that is not a pnpm lockfile, or a
 * lockfile of another format than 9, is refused and not guessed at. Format 9 is what pnpm 9 and
 * pnpm 10 write.
 *
 * The lockfile holds engines, install scripts and the platform a package is built for, so those
 * rules run. It holds no bin names, so a tool run by a name other than its package name is not seen.
 */
import {
  keepReachable,
  markDevOnly,
  type DepGraph,
  type GraphNode,
  type ProjectManifest,
} from "./dependency-surface.js";

export type Yaml = string | Yaml[] | { [key: string]: Yaml };
type YamlMap = { [key: string]: Yaml };

const SUPPORTED_FORMAT = /^9\./;

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'"))
    return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/** Cut a `# comment` that sits outside quotes. */
function withoutComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " ")) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split on a separator that is outside quotes. */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const parts: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** `key: rest` where the key may be quoted. Null when the text has no key. */
function splitKey(text: string): [string, string] | null {
  if (text.startsWith("'") || text.startsWith('"')) {
    const quote = text[0];
    let i = 1;
    for (; i < text.length; i++) {
      if (text[i] === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else break;
      }
    }
    const after = text.slice(i + 1);
    if (!after.startsWith(":")) return null;
    return [unquote(text.slice(0, i + 1)), after.slice(1).trim()];
  }
  const m = /^(.*?):(?:\s+(.*))?$/.exec(text);
  return m ? [m[1], (m[2] ?? "").trim()] : null;
}

function parseFlow(value: string): Yaml {
  if (value.startsWith("{") && value.endsWith("}")) {
    const out: YamlMap = {};
    const inner = value.slice(1, -1).trim();
    if (inner === "") return out;
    for (const item of splitOutsideQuotes(inner, ", ")) {
      const kv = splitKey(item.trim());
      if (kv) out[kv[0]] = parseFlow(kv[1]);
    }
    return out;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : splitOutsideQuotes(inner, ",").map((s) => unquote(s));
  }
  return unquote(value);
}

interface Frame {
  /** Indent of this map's keys; -1 until its first key is seen. */
  indent: number;
  parentIndent: number;
  map: YamlMap;
}

/** Parse the YAML that pnpm writes into nested maps of strings. */
export function parseYamlSubset(text: string): YamlMap {
  const root: YamlMap = {};
  const stack: Frame[] = [{ indent: 0, parentIndent: -1, map: root }];
  for (const raw of text.split("\n")) {
    const line = withoutComment(raw).trimEnd();
    if (line.trim() === "" || line.trim().startsWith("- ")) continue;
    const indent = line.length - line.trimStart().length;
    for (;;) {
      const top = stack[stack.length - 1];
      const leaves = top.indent === -1 ? indent <= top.parentIndent : top.indent > indent;
      if (stack.length > 1 && leaves) stack.pop();
      else break;
    }
    const top = stack[stack.length - 1];
    if (top.indent === -1) top.indent = indent;
    const kv = splitKey(line.trim());
    if (!kv) continue;
    const [key, value] = kv;
    if (value === "") {
      const child: YamlMap = {};
      top.map[key] = child;
      stack.push({ indent: -1, parentIndent: indent, map: child });
    } else {
      top.map[key] = parseFlow(value);
    }
  }
  return root;
}

/** The `lockfileVersion` of a pnpm lockfile, or null when the text does not state one. */
export function pnpmLockfileVersion(text: string): string | null {
  const m = /^lockfileVersion:\s*['"]?([\d.]+)['"]?\s*$/m.exec(text);
  return m ? m[1] : null;
}

const asMap = (v: Yaml | undefined): YamlMap =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};

const asText = (v: Yaml | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** Split `name@1.0.0(peer@2.0.0)` into the name and the version without the peer suffix. */
function splitSnapshotKey(key: string): { name: string; version: string } {
  const at = key.indexOf("@", 1);
  if (at < 0) return { name: key, version: "" };
  return { name: key.slice(0, at), version: key.slice(at + 1).replace(/\(.*$/, "") };
}

/**
 * The snapshot a dependency value points at. Usually the value is a version (`1.0.0`, with an
 * optional peer suffix); an alias gives `other-name@1.0.0` instead.
 */
function snapshotId(name: string, value: string): string {
  return /^@?[^@(]+@./.test(value) ? value : `${name}@${value}`;
}

/** Turn a pnpm lockfile of format 9 into a graph. Null when the text is not one. */
export function graphFromPnpmLock(text: string, _manifest: ProjectManifest): DepGraph | null {
  const format = pnpmLockfileVersion(text);
  if (format === null || !SUPPORTED_FORMAT.test(format)) return null;
  const tree = parseYamlSubset(text);
  const packages = asMap(tree.packages);
  const snapshots = asMap(tree.snapshots);
  const importer = asMap(asMap(tree.importers)["."]);

  const nodes = new Map<string, GraphNode>();
  for (const [id, raw] of Object.entries(snapshots)) {
    const { name, version } = splitSnapshotKey(id);
    const snapshot = asMap(raw);
    const meta = asMap(packages[`${name}@${version}`]);
    const wanted = { ...asMap(snapshot.dependencies), ...asMap(snapshot.optionalDependencies) };
    nodes.set(id, {
      id,
      name,
      version,
      dev: false,
      deps: Object.entries(wanted).map(([dep, value]) => snapshotId(dep, asText(value) ?? "")),
      bins: [],
      engines: asText(asMap(meta.engines).node),
      hasInstallScript: meta.requiresBuild === "true" || snapshot.requiresBuild === "true",
      platformOnly: snapshot.optional === "true" || meta.os !== undefined || meta.cpu !== undefined,
    });
  }
  for (const node of nodes.values()) node.deps = node.deps.filter((d) => nodes.has(d));

  const direct = new Map<string, string>();
  const runtimeRoots: string[] = [];
  const sections: [string, boolean][] = [
    ["dependencies", true],
    ["optionalDependencies", true],
    ["devDependencies", false],
  ];
  for (const [section, runtime] of sections) {
    for (const [name, entry] of Object.entries(asMap(importer[section]))) {
      const version = asText(asMap(entry).version);
      if (version === undefined) continue;
      const id = snapshotId(name, version);
      if (!nodes.has(id)) continue;
      direct.set(name, id);
      if (runtime) runtimeRoots.push(id);
    }
  }
  markDevOnly(nodes, runtimeRoots);
  // A workspace lockfile also holds what its other members need. Count only what this project reaches.
  keepReachable(nodes, [...direct.values()]);
  return { nodes, direct, cannotSee: ["bin names"] };
}

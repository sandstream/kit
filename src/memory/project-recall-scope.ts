/** SQL scope for project-root memory recall. */
import type { DatabaseSync } from "node:sqlite";
import { getProjectRecallRoots } from "./project.js";

/** Compare project roots at a directory boundary. Windows roots allow either native separator. */
export function projectRecallClause(
  db: DatabaseSync,
  projectPath: string,
): {
  sql: string;
  params: string[];
} {
  const value = "COALESCE(m.recall_cwd, m.cwd)";
  const clauses: string[] = [];
  const params: string[] = [];
  for (const root of getProjectRecallRoots(projectPath, db)) {
    const windows = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(root);
    const separator = windows && root.includes("\\") ? "\\" : "/";
    const prefix = `${root.replace(/[\\/]+$/, "")}${separator}`;
    const collation = windows ? " COLLATE NOCASE" : "";
    clauses.push(`(${value} = ?${collation} OR substr(${value}, 1, length(?)) = ?${collation})`);
    params.push(root, prefix, prefix);
  }
  return { sql: `(${clauses.join(" OR ")})`, params };
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSecurityWithProjects, type SecurityLevel } from "./check-projects.js";
import type { SecurityCheckResult } from "./check-security.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const row = (
  name: string,
  status: SecurityCheckResult["status"],
  detail = "",
): SecurityCheckResult => ({ category: "dependency", name, status, detail });

function repo(dirs: string[], manifests: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "kit-proj-"));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const m of manifests) writeFileSync(join(root, m), "{}");
  return root;
}

function recorder(rows: Record<SecurityLevel, SecurityCheckResult[]>) {
  const calls: { dir: string; level: SecurityLevel }[] = [];
  const run = async (dir: string, level: SecurityLevel) => {
    calls.push({ dir, level });
    return rows[level];
  };
  return { calls, run };
}

describe("checkSecurityWithProjects", () => {
  it("without [projects] it runs everything once, in the root, and changes nothing", async () => {
    const root = repo([]);
    try {
      const all = [row("npm audit", "pass"), row("scan scope", "warn")];
      const r = recorder({ all, repo: [], project: [] });
      const out = await checkSecurityWithProjects(root, undefined, r.run);
      assert.deepEqual(out, all);
      assert.deepEqual(r.calls, [{ dir: root, level: "all" }]);
    } finally {
      rmTemp(root);
    }
  });

  it("runs the repo level once in the root and the project level once per path", async () => {
    const root = repo(["backend", "frontend"]);
    try {
      const r = recorder({
        all: [],
        repo: [row("secrets scan", "pass")],
        project: [row("npm audit", "pass")],
      });
      await checkSecurityWithProjects(root, ["backend", "frontend"], r.run);
      assert.deepEqual(r.calls, [
        { dir: root, level: "repo" },
        { dir: join(root, "backend"), level: "project" },
        { dir: join(root, "frontend"), level: "project" },
      ]);
    } finally {
      rmTemp(root);
    }
  });
});

describe("checkSecurityWithProjects, the rows", () => {
  it("names each project row with its path, so one check in two projects is two findings", async () => {
    const root = repo(["backend", "frontend"]);
    try {
      const r = recorder({
        all: [],
        repo: [],
        project: [row("osv-scanner (deps)", "warn", "6 known")],
      });
      const out = await checkSecurityWithProjects(root, ["backend", "frontend"], r.run);
      const names = out.map((x) => x.name).filter((n) => n.startsWith("osv"));
      assert.deepEqual(names, ["osv-scanner (deps) [backend]", "osv-scanner (deps) [frontend]"]);
    } finally {
      rmTemp(root);
    }
  });

  it("keeps a failing project row as a failure and drops project skips", async () => {
    const root = repo(["a"]);
    try {
      const r = recorder({
        all: [],
        repo: [],
        project: [
          row("npm audit", "fail", "1 high"),
          row("pip-audit", "skip", "no requirements.txt"),
        ],
      });
      const out = await checkSecurityWithProjects(root, ["a"], r.run);
      assert.ok(out.some((x) => x.name === "npm audit [a]" && x.status === "fail"));
      assert.ok(!out.some((x) => x.name.startsWith("pip-audit")));
    } finally {
      rmTemp(root);
    }
  });

  it("keeps the root repo-level rows and reports an unscanned project in scope", async () => {
    const root = repo(["a"]);
    try {
      const r = recorder({
        all: [],
        repo: [row("secrets scan", "pass"), row("scan scope", "warn")],
        project: [],
      });
      const out = await checkSecurityWithProjects(root, ["a"], r.run);
      assert.ok(out.some((x) => x.name === "secrets scan"));
      assert.equal(out.filter((x) => x.name === "scan scope").length, 1);
      assert.equal(out.find((x) => x.name === "scan scope")?.status, "warn");
      assert.match(out.find((x) => x.name === "scan scope")?.detail ?? "", /not fully scanned: a/);
    } finally {
      rmTemp(root);
    }
  });
});

describe("checkSecurityWithProjects, the scope row", () => {
  it("says which paths the verdict covers", async () => {
    const root = repo(["backend", "docker"]);
    try {
      const r = recorder({ all: [], repo: [], project: [] });
      const out = await checkSecurityWithProjects(root, ["backend", "docker"], r.run);
      const scope = out.find((x) => x.name === "scan scope");
      assert.match(scope?.detail ?? "", /backend/);
      assert.match(scope?.detail ?? "", /docker/);
    } finally {
      rmTemp(root);
    }
  });

  it("warns, with severity high, about a declared path that was refused", async () => {
    const root = repo(["a"]);
    try {
      const r = recorder({ all: [], repo: [], project: [] });
      const out = await checkSecurityWithProjects(root, ["a", "missing", "../x"], r.run);
      const scope = out.find((x) => x.name === "scan scope");
      assert.equal(scope?.status, "warn");
      assert.equal(scope?.severity, "high");
      assert.match(scope?.detail ?? "", /missing/);
      assert.match(scope?.detail ?? "", /\.\.\/x/);
      assert.ok(!r.calls.some((c) => c.dir.endsWith("missing")));
    } finally {
      rmTemp(root);
    }
  });

  it("warns about a project below the root that [projects] does not list", async () => {
    const root = repo(["backend", "frontend"], []);
    writeFileSync(join(root, "backend", "pom.xml"), "<project/>");
    writeFileSync(join(root, "frontend", "package.json"), "{}");
    try {
      const r = recorder({ all: [], repo: [], project: [] });
      const out = await checkSecurityWithProjects(root, ["backend"], r.run);
      const scope = out.find((x) => x.name === "scan scope");
      assert.equal(scope?.status, "warn");
      assert.match(scope?.detail ?? "", /frontend/);
      assert.match(scope?.detail ?? "", /not listed/);
    } finally {
      rmTemp(root);
    }
  });

  it("an empty list behaves as no [projects]", async () => {
    const root = repo([]);
    try {
      const r = recorder({ all: [row("x", "pass")], repo: [], project: [] });
      await checkSecurityWithProjects(root, [], r.run);
      assert.deepEqual(r.calls, [{ dir: root, level: "all" }]);
    } finally {
      rmTemp(root);
    }
  });
});

describe("checkSecurityWithProjects, coverage the review asked for", () => {
  it("warns about a project where every scanner skipped, instead of listing it as covered", async () => {
    const root = repo(["empty", "real"]);
    try {
      const run = async (dir: string, level: SecurityLevel) =>
        level === "project" && dir.endsWith("empty")
          ? [row("npm audit", "skip", "no package.json found")]
          : level === "project"
            ? [row("npm audit", "pass")]
            : [];
      const out = await checkSecurityWithProjects(root, ["empty", "real"], run);
      const w = out.find((x) => x.name === "nothing scanned [empty]");
      assert.equal(w?.status, "warn");
      assert.ok(!out.some((x) => x.name === "nothing scanned [real]"));
    } finally {
      rmTemp(root);
    }
  });

  it("also runs the project level in the root when the root has a manifest of its own", async () => {
    const root = repo(["backend"], ["package.json"]);
    try {
      const r = recorder({ all: [], repo: [], project: [row("npm audit", "warn", "1 low")] });
      const out = await checkSecurityWithProjects(root, ["backend"], r.run);
      assert.ok(r.calls.some((c) => c.dir === root && c.level === "project"));
      assert.ok(out.some((x) => x.name === "npm audit"));
      assert.ok(out.some((x) => x.name === "npm audit [backend]"));
    } finally {
      rmTemp(root);
    }
  });

  it("also runs it in the root when the root holds infrastructure code", async () => {
    const root = repo(["backend"], ["Dockerfile"]);
    try {
      const r = recorder({ all: [], repo: [], project: [row("trivy config (IaC)", "pass")] });
      await checkSecurityWithProjects(root, ["backend"], r.run);
      assert.ok(r.calls.some((c) => c.dir === root && c.level === "project"));
    } finally {
      rmTemp(root);
    }
  });

  it("does not run it in a root that has neither", async () => {
    const root = repo(["backend"]);
    try {
      const r = recorder({ all: [], repo: [], project: [row("npm audit", "pass")] });
      await checkSecurityWithProjects(root, ["backend"], r.run);
      assert.ok(!r.calls.some((c) => c.dir === root && c.level === "project"));
    } finally {
      rmTemp(root);
    }
  });
});

describe("checkSecurityWithProjects, remaining coverage paths", () => {
  it("runs the extra project checks in every project and names them by path", async () => {
    const root = repo(["frontend"]);
    try {
      const r = recorder({ all: [], repo: [], project: [row("npm audit", "pass")] });
      const seen: string[] = [];
      const extras = async (dir: string) => {
        seen.push(dir);
        return [row("built bundle secrets", "pass"), row("client-exposed env names", "skip")];
      };
      const out = await checkSecurityWithProjects(root, ["frontend"], r.run, extras);
      assert.deepEqual(seen, [join(root, "frontend")]);
      assert.ok(out.some((x) => x.name === "built bundle secrets [frontend]"));
      assert.ok(!out.some((x) => x.name.startsWith("client-exposed")));
    } finally {
      rmTemp(root);
    }
  });

  it("a project that is the parent of a listed path is not covered by it", async () => {
    const root = repo(["services/api"]);
    writeFileSync(join(root, "services", "package.json"), "{}");
    try {
      const r = recorder({ all: [], repo: [], project: [row("npm audit", "pass")] });
      const out = await checkSecurityWithProjects(root, ["services/api"], r.run);
      const scope = out.find((x) => x.name === "scan scope");
      assert.equal(scope?.status, "warn");
      assert.match(scope?.detail ?? "", /services/);
    } finally {
      rmTemp(root);
    }
  });

  it("does not treat a nested manifest as covered by its listed parent", async () => {
    const root = repo(["services/api"], ["services/package.json"]);
    writeFileSync(join(root, "services", "api", "package.json"), "{}");
    try {
      const r = recorder({ all: [], repo: [], project: [row("npm audit", "pass")] });
      const out = await checkSecurityWithProjects(root, ["services"], r.run);
      const scope = out.find((x) => x.name === "scan scope");
      assert.equal(scope?.status, "warn");
      assert.match(scope?.detail ?? "", /services\/api/);
    } finally {
      rmTemp(root);
    }
  });

  it("runs the root project scan for infrastructure outside the listed paths", async () => {
    const root = repo(["frontend", "docker"], ["docker/Dockerfile"]);
    try {
      const r = recorder({ all: [], repo: [], project: [row("trivy config (IaC)", "pass")] });
      await checkSecurityWithProjects(root, ["frontend"], r.run);
      assert.ok(r.calls.some((c) => c.dir === root && c.level === "project"));
    } finally {
      rmTemp(root);
    }
  });

  it("warns when a declared project has no manifest even if an unrelated scanner passes", async () => {
    const root = repo(["empty"]);
    try {
      const r = recorder({ all: [], repo: [], project: [row("semgrep", "pass")] });
      const out = await checkSecurityWithProjects(root, ["empty"], r.run);
      assert.ok(out.some((x) => x.name === "manifest scope [empty]" && x.status === "warn"));
      assert.equal(out.find((x) => x.name === "scan scope")?.status, "warn");
    } finally {
      rmTemp(root);
    }
  });
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { checkDeploy } from "./check-deploy.js";
import type { DeployListResult, VercelDeployTarget } from "./check-deploy.js";
import {
  collectCodeEnvNames,
  evaluateVercelEnvSafety,
  parseVercelEnvMeta,
} from "./check-deploy-vercel-safety.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

type Meta = { key: string; type?: string; targets: string[]; securityIssues: unknown[] };
const meta = (key: string, targets: string[], extra: Partial<Meta> = {}): Meta => ({
  key,
  type: "encrypted",
  targets,
  securityIssues: [],
  ...extra,
});

function inProject(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kit-vercel-safety-"));
  for (const [f, text] of Object.entries(files)) {
    const full = join(dir, f);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return body(dir).finally(() => rmTemp(dir));
}

const lister =
  (vars: Meta[] | undefined) =>
  async (target: VercelDeployTarget): Promise<DeployListResult> => ({
    ok: true,
    names: (vars ?? []).map((v) => v.key),
    detail: "listed",
    ...(vars
      ? {
          vars: vars.filter(
            (v) => !target.remoteEnv || v.targets.includes(target.remoteEnv),
          ) as never,
        }
      : {}),
  });

const config = (extra: Record<string, unknown> = {}) => ({
  vercel: {
    ...extra,
    environments: {
      production: { project: "app", remote_env: "production" as const },
      preview: { project: "app", remote_env: "preview" as const },
    },
  },
});

const CODE = {
  "src/app.ts": [
    "const a = process.env.STRIPE_SECRET_KEY;",
    'const b = process.env["SESSION_SECRET"];',
    "const c = import.meta.env.PUBLIC_X;",
    'const d = Deno.env.get("EDGE_TOKEN");',
    "const { DATABASE_URL, QUEUE_NAME } = process.env;",
  ].join("\n"),
  "prisma/schema.prisma": 'url = env("PRISMA_URL")\n',
  ".env.example": "ONLY_IN_EXAMPLE=\nOLD_KEY=\n",
};

const rowFor = (rows: Awaited<ReturnType<typeof checkDeploy>>, env: string) =>
  rows.find((r) => r.environment === env)!;

describe("parseVercelEnvMeta", () => {
  it("reads key, type, targets and securityIssues from the Vercel env list", () => {
    const got = parseVercelEnvMeta({
      envs: [
        { key: "A_KEY", type: "sensitive", target: ["production"], securityIssues: [], value: "x" },
        {
          key: "B_KEY",
          type: "encrypted",
          target: ["production", "preview"],
          securityIssues: ["readable-secret"],
        },
        { key: "bad key", target: ["production"] },
      ],
    });
    assert.deepEqual(
      got.map((v) => [v.key, v.type, v.targets, v.securityIssues]),
      [
        ["A_KEY", "sensitive", ["production"], []],
        ["B_KEY", "encrypted", ["production", "preview"], ["readable-secret"]],
      ],
    );
  });

  it("never carries the value", () => {
    const got = parseVercelEnvMeta({
      envs: [{ key: "A_KEY", target: ["production"], value: "TOP-SECRET" }],
    });
    assert.ok(!JSON.stringify(got).includes("TOP-SECRET"));
  });

  it("accepts a securityIssues entry written as an object", () => {
    const got = parseVercelEnvMeta({
      envs: [
        { key: "A_KEY", target: ["production"], securityIssues: [{ type: "readable-secret" }] },
      ],
    });
    assert.deepEqual(got[0].securityIssues, ["readable-secret"]);
  });
});

describe("evaluateVercelEnvSafety", () => {
  const base = {
    sharedOk: [],
    implicit: [],
    declared: [],
    codeNames: new Set(["STRIPE_SECRET_KEY", "SESSION_SECRET"]),
  };

  it("lists the keys Vercel flags as readable-secret", () => {
    const got = evaluateVercelEnvSafety({
      ...base,
      remoteEnv: "production",
      vars: [
        meta("STRIPE_SECRET_KEY", ["production"], { securityIssues: ["readable-secret"] }) as never,
      ],
    });
    assert.deepEqual(got.readableSecret, ["STRIPE_SECRET_KEY"]);
  });

  it("flags a secret-like entry that targets production and preview at once, and not a public one", () => {
    const vars = [
      meta("SESSION_SECRET", ["production", "preview"], { type: "sensitive" }),
      meta("NEXT_PUBLIC_API_URL", ["production", "preview"], { type: "plain" }),
      meta("STRIPE_SECRET_KEY", ["production"]),
    ] as never;
    assert.deepEqual(evaluateVercelEnvSafety({ ...base, remoteEnv: "production", vars }).shared, [
      "SESSION_SECRET",
    ]);
  });

  it("does not call two single-target entries shared, because their values cannot be compared", () => {
    const vars = [
      meta("SESSION_SECRET", ["production"]),
      meta("SESSION_SECRET", ["preview"]),
    ] as never;
    assert.deepEqual(
      evaluateVercelEnvSafety({ ...base, remoteEnv: "production", vars }).shared,
      [],
    );
  });

  it("respects the shared_ok list", () => {
    const vars = [meta("SESSION_SECRET", ["production", "preview"])] as never;
    assert.deepEqual(
      evaluateVercelEnvSafety({
        ...base,
        sharedOk: ["SESSION_SECRET"],
        remoteEnv: "production",
        vars,
      }).shared,
      [],
    );
  });

  it("lists keys no source file names, except system, declared and implicit ones", () => {
    const vars = [
      "OLD_KEY",
      "VERCEL_URL",
      "NEXTAUTH_SECRET",
      "MY_IMPLICIT",
      "REQUIRED_KEY",
      "STRIPE_SECRET_KEY",
    ].map((k) => meta(k, ["production"])) as never;
    const got = evaluateVercelEnvSafety({
      ...base,
      implicit: ["MY_IMPLICIT"],
      declared: ["REQUIRED_KEY"],
      remoteEnv: "production",
      vars,
    });
    assert.deepEqual(got.unread, ["OLD_KEY"]);
  });

  it("says unread is unverified, not clean, when there is no code to search", () => {
    const got = evaluateVercelEnvSafety({
      ...base,
      codeNames: null,
      remoteEnv: "production",
      vars: [meta("OLD_KEY", ["production"]) as never],
    });
    assert.deepEqual(got.unread, []);
    assert.equal(got.unreadChecked, false);
  });
});

describe("collectCodeEnvNames", () => {
  it("finds the names the code reads, in every form, and ignores env files and vendored folders", () =>
    inProject(
      {
        ...CODE,
        "node_modules/x/index.js": "process.env.IN_NODE_MODULES",
        ".github/workflows/a.yml": "GH_ONLY: 1",
      },
      async (dir) => {
        const names = collectCodeEnvNames(dir)!;
        for (const n of [
          "STRIPE_SECRET_KEY",
          "SESSION_SECRET",
          "PUBLIC_X",
          "EDGE_TOKEN",
          "DATABASE_URL",
          "QUEUE_NAME",
          "PRISMA_URL",
        ]) {
          assert.ok(names.has(n), n);
        }
        for (const n of ["ONLY_IN_EXAMPLE", "OLD_KEY", "IN_NODE_MODULES", "GH_ONLY"])
          assert.ok(!names.has(n), n);
      },
    ));

  it("returns null when the folder holds no source file", () =>
    inProject({ "README.md": "# hi" }, async (dir) =>
      assert.equal(collectCodeEnvNames(dir), null),
    ));

  it("does not follow a symlinked source file", () =>
    inProject({ "secret.txt": "process.env.VIA_LINK" }, async (dir) => {
      symlinkSync(join(dir, "secret.txt"), join(dir, "linked.ts"));
      assert.equal(collectCodeEnvNames(dir), null);
    }));
});

describe("kit check on a Vercel project", () => {
  it("fails a readable-secret and names the key and the way out", () =>
    inProject(CODE, async (dir) => {
      const rows = await checkDeploy(config(), dir, {
        listVercelEnvNames: lister([
          meta("STRIPE_SECRET_KEY", ["production"], { securityIssues: ["readable-secret"] }),
        ]),
      });
      const prod = rowFor(rows, "production");
      assert.equal(prod.status, "fail");
      assert.deepEqual(prod.unsafe?.readableSecret, ["STRIPE_SECRET_KEY"]);
      assert.match(prod.detail, /readable-secret: STRIPE_SECRET_KEY/);
      assert.match(prod.detail, /sensitive/);
    }));

  it("fails a secret shared between production and preview on both rows", () =>
    inProject(CODE, async (dir) => {
      const rows = await checkDeploy(config(), dir, {
        listVercelEnvNames: lister([
          meta("SESSION_SECRET", ["production", "preview"], { type: "sensitive" }),
        ]),
      });
      for (const env of ["production", "preview"]) {
        assert.equal(rowFor(rows, env).status, "fail", env);
        assert.deepEqual(rowFor(rows, env).unsafe?.shared, ["SESSION_SECRET"], env);
      }
    }));
});

describe("kit check on a Vercel project, exceptions and gaps", () => {
  it("passes the same variable once shared_ok names it", () =>
    inProject(CODE, async (dir) => {
      const rows = await checkDeploy(config({ shared_ok: ["SESSION_SECRET"] }), dir, {
        listVercelEnvNames: lister([
          meta("SESSION_SECRET", ["production", "preview"], { type: "sensitive" }),
        ]),
      });
      assert.equal(rowFor(rows, "production").status, "pass");
    }));

  it("fails a variable the code never reads, and passes once implicit_env names it", () =>
    inProject(CODE, async (dir) => {
      const vars = [meta("OLD_KEY", ["production"])];
      const failing = await checkDeploy(config(), dir, { listVercelEnvNames: lister(vars) });
      assert.equal(rowFor(failing, "production").status, "fail");
      assert.deepEqual(rowFor(failing, "production").unsafe?.unread, ["OLD_KEY"]);
      const ok = await checkDeploy(config({ implicit_env: ["OLD_KEY"] }), dir, {
        listVercelEnvNames: lister(vars),
      });
      assert.equal(rowFor(ok, "production").status, "pass");
    }));

  it("passes a clean project", () =>
    inProject(CODE, async (dir) => {
      const rows = await checkDeploy(config(), dir, {
        listVercelEnvNames: lister([
          meta("STRIPE_SECRET_KEY", ["production"], { type: "sensitive" }),
        ]),
      });
      assert.equal(rowFor(rows, "production").status, "pass");
      assert.equal(rowFor(rows, "production").unsafe, undefined);
    }));

  it("says so when the listing carries no type, target or security data, and keeps the names check", () =>
    inProject(CODE, async (dir) => {
      const rows = await checkDeploy(config(), dir, { listVercelEnvNames: lister(undefined) });
      const prod = rowFor(rows, "production");
      assert.match(prod.detail, /VERCEL_TOKEN/);
      assert.deepEqual(prod.unverified, ["readable-secret", "shared", "unread"]);
    }));

  it("never prints a value", () =>
    inProject(CODE, async (dir) => {
      const rows = await checkDeploy(config(), dir, {
        listVercelEnvNames: lister([
          {
            ...meta("STRIPE_SECRET_KEY", ["production"], { securityIssues: ["readable-secret"] }),
            value: "TOP-SECRET",
          } as never,
        ]),
      });
      assert.ok(!JSON.stringify(rows).includes("TOP-SECRET"));
    }));
});

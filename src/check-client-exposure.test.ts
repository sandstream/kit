/**
 * The leak this covers never touches git.
 *
 * A `VITE_*` or `NEXT_PUBLIC_*` variable holding a real secret is inlined into the bundle at build
 * time and shipped to every visitor. Trufflehog over history cannot see it, `.gitignore` does not
 * protect against it, and the value is public the moment the site deploys. So the properties below
 * are about the two ways to catch it — the name, before the build; the bytes, after it.
 *
 * The false-positive cases carry as much weight as the true ones, and are the reason this check is
 * usable at all:
 *
 *   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `..._STRIPE_PUBLISHABLE_KEY` are the two most common
 *     client env vars in existence and are meant to be public. A check that flags them on day one
 *     is switched off before it ever catches a real leak.
 *   - kit's own `dist/` is a compiled Node CLI. Scanning it produced 73 "credential shapes", every
 *     one a test fixture or one of kit's own detection patterns — measured, which is why the bundle
 *     check requires a client framework and ignores compiled tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyClientName,
  collectEnvNames,
  checkClientExposedNames,
  checkBuiltBundleSecrets,
  detectClientBuilds,
  isTestArtifact,
} from "./check-client-exposure.js";

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-client-exp-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("classifyClientName", () => {
  it("calls a client-exposed secret name what it is", () => {
    for (const name of [
      "VITE_STRIPE_SECRET_KEY",
      "NEXT_PUBLIC_DATABASE_PASSWORD",
      "PUBLIC_ADMIN_TOKEN",
      "REACT_APP_PRIVATE_SIGNING_KEY",
      "EXPO_PUBLIC_SERVICE_CREDENTIAL",
      "GATSBY_API_KEY",
    ]) {
      assert.equal(classifyClientName(name), "leak", name);
    }
  });

  it("excuses the secret-shaped names that are public by design", () => {
    // These read as credentials and are meant to be published. Getting this group wrong is how the
    // check ends up disabled: they are the most common client env vars there are.
    for (const name of [
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
      "VITE_RECAPTCHA_SITE_KEY",
      "VITE_VAPID_PUBLIC_KEY",
    ]) {
      assert.equal(classifyClientName(name), "public-by-convention", name);
    }
  });

  it("never flags a name that a build would inline harmlessly", () => {
    // The property that matters is "not a leak"; whether a name is excused by the public-by-design
    // list or never looked secret-shaped at all is an internal distinction.
    for (const name of [
      "NEXT_PUBLIC_SENTRY_DSN",
      "VITE_AUTH0_CLIENT_ID",
      "NEXT_PUBLIC_GA_MEASUREMENT_ID",
      "VITE_API_URL",
      "NEXT_PUBLIC_APP_URL",
    ]) {
      assert.notEqual(classifyClientName(name), "leak", name);
    }
  });

  it("ignores names the browser never sees, however secret they sound", () => {
    for (const name of [
      "STRIPE_SECRET_KEY",
      "DATABASE_URL",
      "CRON_SECRET",
      "AZURE_CLIENT_SECRET",
    ]) {
      assert.equal(classifyClientName(name), "not-client-exposed", name);
    }
  });

  it("ignores a client-exposed name that says nothing about secrets", () => {
    for (const name of ["VITE_API_URL", "NEXT_PUBLIC_APP_URL", "PUBLIC_SITE_NAME"]) {
      assert.equal(classifyClientName(name), "not-client-exposed", name);
    }
  });
});

describe("collectEnvNames", () => {
  it("reads names from every .env file, and never a value", async () => {
    const dir = tree({
      ".env": "VITE_A=super-secret-value\n# comment\n\nexport VITE_B=other\n",
      ".env.example": "VITE_A=changeme\nVITE_C=\n",
      ".envrc": "should not be read as env\n",
      "not-env.txt": "VITE_D=x\n",
    });
    try {
      const names = await collectEnvNames(dir);
      assert.deepEqual([...names.keys()].sort(), ["VITE_A", "VITE_B", "VITE_C"]);
      assert.deepEqual(names.get("VITE_A"), [".env", ".env.example"], "both sources are named");
      // The values are dropped at the parse — nothing downstream can leak what it never received.
      assert.equal(JSON.stringify([...names.values()]).includes("super-secret-value"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkClientExposedNames", () => {
  it("fails on a secret-shaped client name and says how to resolve it", async () => {
    const dir = tree({ ".env": "VITE_STRIPE_SECRET_KEY=x\nVITE_API_URL=y\n" });
    try {
      const r = await checkClientExposedNames(dir);
      assert.equal(r.status, "fail");
      assert.equal(r.severity, "high");
      assert.match(r.detail, /VITE_STRIPE_SECRET_KEY/);
      assert.match(String(r.suggestion), /client_exposed_allow/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an allowlisted name that carries a reason", async () => {
    const dir = tree({ ".env": "VITE_DEMO_SECRET_KEY=x\n" });
    try {
      const r = await checkClientExposedNames(dir, {
        VITE_DEMO_SECRET_KEY: "demo tenant, rotated nightly",
      });
      assert.equal(r.status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an allowlist entry with no reason — nobody can audit 'someone allowed it once'", async () => {
    const dir = tree({ ".env": "VITE_DEMO_SECRET_KEY=x\n" });
    try {
      const r = await checkClientExposedNames(dir, { VITE_DEMO_SECRET_KEY: "  " });
      assert.equal(r.status, "warn");
      assert.match(r.detail, /carry no reason/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips, with the reason, when there are no names to read", async () => {
    const dir = tree({ "package.json": "{}" });
    try {
      const r = await checkClientExposedNames(dir);
      assert.equal(r.status, "skip");
      assert.match(r.detail, /no \.env\* files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("also judges names declared only in .kit.toml", async () => {
    const dir = tree({ "package.json": "{}" });
    try {
      const r = await checkClientExposedNames(dir, {}, ["NEXT_PUBLIC_ADMIN_TOKEN"]);
      assert.equal(r.status, "fail");
      assert.match(r.detail, /\.kit\.toml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detectClientBuilds", () => {
  it("finds the framework in a workspace package, not just the root", async () => {
    // The shape measured on a real repo: the root declares workspaces and no framework, and the
    // app that ships lives one level in. A root-only check called that "nothing builds for a
    // browser".
    const dir = tree({
      "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
      "apps/web/package.json": JSON.stringify({ devDependencies: { vite: "^5" } }),
      "packages/ui/package.json": JSON.stringify({ dependencies: { react: "^18" } }),
    });
    try {
      const builds = await detectClientBuilds(dir);
      assert.deepEqual(builds, [{ framework: "vite", dir: "apps/web" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds nothing in a project that does not build for a browser", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ dependencies: { express: "^4" } }),
    });
    try {
      assert.deepEqual(await detectClientBuilds(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkBuiltBundleSecrets", () => {
  it("finds a credential that was inlined into the bundle", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ devDependencies: { vite: "^5" } }),
      "dist/assets/index-abc.js": `const k="sk_live_${"A".repeat(24)}";export default k;\n`,
    });
    try {
      const r = await checkBuiltBundleSecrets(dir);
      assert.equal(r.status, "fail");
      assert.equal(r.severity, "critical");
      assert.match(r.detail, /dist\/assets\/index-abc\.js/);
      // Rotation first: removing it from the build does not un-publish what already shipped.
      assert.match(String(r.suggestion), /Rotate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not scan a Node CLI's dist — that is not a browser bundle", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ dependencies: { commander: "^12" } }),
      "dist/cli.js": `const k="sk_live_${"A".repeat(24)}";\n`,
    });
    try {
      const r = await checkBuiltBundleSecrets(dir);
      assert.equal(r.status, "skip");
      assert.match(r.detail, /nothing builds for a browser/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says the build has not run rather than calling an unbuilt project clean", async () => {
    const dir = tree({ "package.json": JSON.stringify({ devDependencies: { next: "^14" } }) });
    try {
      const r = await checkBuiltBundleSecrets(dir);
      assert.equal(r.status, "skip");
      assert.match(r.detail, /not built/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a compiled test fixture as a shipped credential", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ devDependencies: { vite: "^5" } }),
      "dist/thing.test.js": `const k="sk_live_${"A".repeat(24)}";\n`,
    });
    try {
      const r = await checkBuiltBundleSecrets(dir);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /test fixture\(s\) not counted/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies test artifacts by path, including mocks and fixtures", () => {
    assert.equal(isTestArtifact("dist/a.test.js"), true);
    assert.equal(isTestArtifact("dist/a.spec.mjs"), true);
    assert.equal(isTestArtifact("dist/__tests__/a.js"), true);
    assert.equal(isTestArtifact("dist/fixtures/a.js"), true);
    assert.equal(isTestArtifact("dist/assets/index-abc.js"), false);
    assert.equal(isTestArtifact("dist/latest.js"), false, "a name containing 'test' is not a test");
  });
});

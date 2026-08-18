import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateToml, parseEnvTemplateKeys, type InitGap } from "./toml-generator.js";
import type { DetectedStack } from "./stack-detector.js";
import { parse as parseTOML } from "smol-toml";

function stack(overrides: Partial<DetectedStack> = {}): DetectedStack {
  return {
    language: "typescript",
    services: [],
    tools: { node: "22" },
    confidence: 0.9,
    ...overrides,
  };
}

/** Most tests only care about the rendered file; gaps get their own describe below. */
function gen(s: DetectedStack, options: Parameters<typeof generateToml>[1] = {}): string {
  return generateToml(s, options).toml;
}

describe("generateToml", () => {
  it("generates valid TOML for a minimal stack", () => {
    const toml = gen(stack());
    // Should parse without throwing
    const parsed = parseTOML(toml);
    assert.ok(parsed, "should produce parseable TOML");
  });

  it("includes node version in [tools]", () => {
    const toml = gen(stack({ tools: { node: "22", pnpm: "latest" } }));
    assert.ok(toml.includes('node = "22"'), `missing node in: ${toml}`);
    assert.ok(toml.includes('pnpm = "latest"'), `missing pnpm in: ${toml}`);
  });

  it("includes the default security scanners (semgrep + socket + trufflehog) as mise tools", () => {
    const parsed = parseTOML(gen(stack())) as { tools: Record<string, string> };
    assert.equal(parsed.tools.semgrep, "latest", "semgrep should be a default tool");
    assert.equal(
      parsed.tools["npm:@socketsecurity/cli"],
      "latest",
      "socket should be a default tool (npm backend ref, quoted key)",
    );
    assert.equal(
      parsed.tools["aqua:trufflesecurity/trufflehog"],
      "latest",
      "trufflehog should be a default tool (deep secret scan on by default)",
    );
  });

  it("provisions trivy only when a Dockerfile is present", () => {
    const without = parseTOML(gen(stack())) as { tools: Record<string, string> };
    assert.ok(!without.tools["aqua:aquasecurity/trivy"], "no trivy without a Dockerfile");
    const withDocker = parseTOML(gen(stack(), { hasDockerfile: true })) as {
      tools: Record<string, string>;
    };
    assert.equal(
      withDocker.tools["aqua:aquasecurity/trivy"],
      "latest",
      "trivy provisioned with a Dockerfile",
    );
  });

  it("provisions pip-audit for Python and osv-scanner for non-node ecosystems (not for node)", () => {
    const node = parseTOML(gen(stack({ language: "typescript" }))) as {
      tools: Record<string, string>;
    };
    assert.ok(!node.tools["aqua:google/osv-scanner"], "no osv for node (npm audit covers it)");
    assert.ok(!node.tools["pipx:pip-audit"], "no pip-audit for node");

    const python = parseTOML(gen(stack({ language: "python", tools: {} }))) as {
      tools: Record<string, string>;
    };
    assert.equal(python.tools["pipx:pip-audit"], "latest", "pip-audit for python");
    assert.ok(!python.tools["aqua:google/osv-scanner"], "no osv for python (pip-audit covers it)");

    const go = parseTOML(gen(stack({ language: "go", tools: {} }))) as {
      tools: Record<string, string>;
    };
    assert.equal(
      go.tools["aqua:google/osv-scanner"],
      "latest",
      "osv-scanner for go (no dedicated scanner)",
    );
  });

  it("parseEnvTemplateKeys extracts KEY= names, ignoring comments / blanks / lowercase", () => {
    assert.deepEqual(parseEnvTemplateKeys("# comment\nFOO=1\nexport BAR=2\n\nbaz=3\nQUX_1=\n"), [
      "FOO",
      "BAR",
      "QUX_1",
    ]);
  });

  it("seeds extra secret keys from an env template, deduped against service keys", () => {
    const toml = gen(stack({ services: ["supabase"] }), {
      secretsStore: "1password",
      extraSecretKeys: ["OPENAI_API_KEY", "NEXT_PUBLIC_SUPABASE_URL"],
    });
    assert.ok(toml.includes("OPENAI_API_KEY"), `extra key missing: ${toml}`);
    const dupes = (toml.match(/^NEXT_PUBLIC_SUPABASE_URL = /gm) || []).length;
    assert.equal(dupes, 1, "service key must not be duplicated by the env-template seed");
  });

  it("generates config for a new registry-only service (convex) — no code change needed", () => {
    const toml = gen(stack({ services: ["convex"] }), { secretsStore: "infisical" });
    const parsed = parseTOML(toml) as Record<string, unknown>;
    assert.ok(parsed, "valid TOML");
    assert.ok(toml.includes("[services.convex]"), `missing convex service section: ${toml}`);
    assert.ok(toml.includes("CONVEX_DEPLOYMENT"), `missing convex secret key: ${toml}`);
  });

  it("provisions the chosen vault's CLI into [tools] (mise-installable backends)", () => {
    const infisical = parseTOML(
      gen(stack({ services: ["supabase"] }), { secretsStore: "infisical" }),
    ) as { tools: Record<string, string> };
    assert.equal(infisical.tools.infisical, "latest", "infisical CLI should be provisioned");

    const doppler = parseTOML(
      gen(stack({ services: ["supabase"] }), { secretsStore: "doppler" }),
    ) as { tools: Record<string, string> };
    assert.equal(doppler.tools.doppler, "latest", "doppler CLI should be provisioned");

    const vault = parseTOML(gen(stack({ services: ["supabase"] }), { secretsStore: "vault" })) as {
      tools: Record<string, string>;
    };
    assert.equal(vault.tools.vault, "latest", "vault CLI should be provisioned");
  });

  it("does not provision a CLI for env or cloud-managed backends (aws/gcp/azure)", () => {
    const env = parseTOML(gen(stack({ services: ["supabase"] }), { secretsStore: "env" })) as {
      tools: Record<string, string>;
    };
    // env: nothing vault-y; cloud SMs ship their CLI via the cloud env, not mise.
    const awsSm = parseTOML(gen(stack({ services: ["supabase"] }), { secretsStore: "aws-sm" })) as {
      tools: Record<string, string>;
    };
    assert.ok(!awsSm.tools.aws && !awsSm.tools["aws-sm"], "no aws CLI provisioned for aws-sm");
    assert.ok(env.tools, "env still has a tools table (scanners etc.)");
  });

  it("scaffolds a [secrets.infisical] binding block when infisical is chosen", () => {
    const toml = gen(stack({ services: ["supabase", "stripe"] }), {
      secretsStore: "infisical",
    });
    assert.ok(toml.includes("[secrets.infisical]"), `missing binding block: ${toml}`);
    const parsed = parseTOML(toml) as { secrets: { infisical?: { environment?: string } } };
    assert.equal(
      parsed.secrets.infisical?.environment,
      "dev",
      "binding should default environment to dev",
    );
    // No binding block for a non-infisical store.
    const op = gen(stack({ services: ["supabase"] }), { secretsStore: "1password" });
    assert.ok(
      !op.includes("[secrets.infisical]"),
      "1password config must not carry an infisical block",
    );
  });

  it("generates Next.js + Supabase + Stripe config", () => {
    const s = stack({
      framework: "nextjs",
      services: ["supabase", "stripe"],
      tools: { node: "22", pnpm: "latest", supabase: "latest", stripe: "latest" },
    });
    const toml = gen(s, { secretsStore: "1password" });
    const parsed = parseTOML(toml) as Record<string, unknown>;

    assert.ok(toml.includes("[services.supabase]"), "missing services.supabase");
    assert.ok(toml.includes("[services.stripe]"), "missing services.stripe");
    assert.ok(toml.includes("[secrets]"), "missing secrets section");
    assert.ok(toml.includes("STRIPE_SECRET_KEY"), "missing stripe secret key");
    assert.ok(toml.includes("NEXT_PUBLIC_SUPABASE_URL"), "missing supabase URL key");
    assert.ok(parsed, "should be valid TOML");
  });

  it("generates [setup] section with pnpm install for Next.js", () => {
    const s = stack({
      framework: "nextjs",
      tools: { node: "22", pnpm: "latest" },
      services: [],
    });
    const toml = gen(s);
    assert.ok(toml.includes("[setup]"), "missing setup section");
    assert.ok(toml.includes("pnpm install"), `expected pnpm install in: ${toml}`);
  });

  it("generates supabase db push migrate command when supabase detected", () => {
    const s = stack({
      framework: "nextjs",
      services: ["supabase"],
      tools: { node: "22", pnpm: "latest" },
    });
    const toml = gen(s);
    assert.ok(toml.includes("supabase db push"), `expected migrate cmd: ${toml}`);
  });

  it("generates Python FastAPI config", () => {
    const s = stack({
      language: "python",
      framework: "fastapi",
      services: [],
      tools: { python: "3.12", uv: "latest" },
    });
    const toml = gen(s);
    const parsed = parseTOML(toml);
    assert.ok(parsed, "valid TOML");
    assert.ok(toml.includes('python = "3.12"'), `missing python version: ${toml}`);
    assert.ok(toml.includes("uv sync"), `expected uv sync install: ${toml}`);
  });

  it("generates Go/Gin config", () => {
    const s = stack({
      language: "go",
      framework: "gin",
      services: [],
      tools: { go: "1.22" },
    });
    const toml = gen(s);
    const parsed = parseTOML(toml);
    assert.ok(parsed, "valid TOML");
    assert.ok(toml.includes('go = "1.22"'), `missing go version: ${toml}`);
    assert.ok(toml.includes("go mod download"), `expected install cmd: ${toml}`);
  });

  it("includes comment header with detected stack", () => {
    const s = stack({ framework: "nextjs", services: ["stripe"] });
    const toml = gen(s);
    assert.ok(toml.includes("# .kit.toml"), "missing header comment");
    assert.ok(toml.includes("nextjs"), `missing framework in header: ${toml}`);
  });

  it("adds service tool to [tools] section when not already present", () => {
    const s = stack({
      framework: "nextjs",
      services: ["stripe"],
      tools: { node: "22", pnpm: "latest" },
    });
    const toml = gen(s);
    // stripe CLI tool should be added automatically
    assert.ok(toml.includes("stripe"), `expected stripe tool: ${toml}`);
  });

  it("generates no secrets section when no services detected", () => {
    const s = stack({ framework: "express", services: [], tools: { node: "22" } });
    const toml = gen(s);
    // secrets section should be absent or empty
    const parsed = parseTOML(toml) as Record<string, unknown>;
    assert.ok(!parsed.secrets, "should not have secrets when no services");
  });
});

// ---------------------------------------------------------------------------
// No guessing: every field kit cannot prove becomes a GAP, never a default.
// ---------------------------------------------------------------------------
// Each test here encodes a line that a real `kit init` run wrote into a real
// repo and got wrong. A generated value that is merely plausible is worse than
// an absent one: it looks decided, so nobody re-examines it.

describe("generateToml — refuses to guess", () => {
  const gapFor = (gaps: InitGap[], path: string): InitGap | undefined =>
    gaps.find((g) => g.path === path);

  it("writes no [secrets] block and no vault when the store is unknown", () => {
    // The bug: `secretsStore ?? "1password"` picked a vault the user does not use,
    // wrote op:// refs that point nowhere, and pulled the 1password CLI into [tools]
    // — where `kit triage` blocked it and killed setup.
    const { toml, gaps } = generateToml(stack({ services: ["supabase", "stripe"] }));

    assert.ok(!toml.includes("1password"), `no vault may be assumed: ${toml}`);
    assert.ok(!toml.includes("op://"), `no placeholder vault refs: ${toml}`);
    assert.ok(!parseTOML(toml).secrets, "no [secrets] section without a known store");

    const gap = gapFor(gaps, "secrets.store");
    assert.ok(gap, `expected a secrets.store gap, got: ${JSON.stringify(gaps)}`);
    assert.equal(gap.owner, "agent", "an agent can know which vault the user runs");
    assert.match(gap.fix, /kit init --store/, "gap must name the command that resolves it");
  });

  it("still writes [secrets] once a store is supplied", () => {
    const { toml, gaps } = generateToml(stack({ services: ["supabase"] }), {
      secretsStore: "infisical",
    });
    assert.ok(toml.includes("[secrets]"), "a supplied store is written");
    assert.ok(!gapFor(gaps, "secrets.store"), "no gap once the store is known");
  });

  it("never invents setup.verify, and offers the repo's scripts as candidates", () => {
    // The bug: the framework table mapped react -> `pnpm build`. In a bun repo whose
    // build script starts with `convex deploy`, running that gate would have deployed
    // the backend. kit cannot know which script is safe; only a reader of the repo can.
    const { toml, gaps } = generateToml(stack({ framework: "react", tools: { bun: "latest" } }), {
      packageScripts: ["dev", "build", "typecheck", "test"],
    });

    assert.ok(!toml.includes("verify"), `verify must not be guessed: ${toml}`);
    assert.ok(!toml.includes("pnpm"), `no package manager may be assumed: ${toml}`);

    const gap = gapFor(gaps, "setup.verify");
    assert.ok(gap, `expected a setup.verify gap, got: ${JSON.stringify(gaps)}`);
    assert.deepEqual(gap.candidates, ["dev", "build", "typecheck", "test"]);
    assert.equal(gap.owner, "agent");
  });

  it("writes setup.verify when it is supplied, with no gap left behind", () => {
    const { toml, gaps } = generateToml(stack({ framework: "react", tools: { bun: "latest" } }), {
      verify: "bun run typecheck",
    });
    assert.ok(toml.includes('verify = "bun run typecheck"'), `expected supplied verify: ${toml}`);
    assert.ok(!gapFor(gaps, "setup.verify"), "no gap once verify is known");
  });

  it("names the env template that actually exists, and omits the line otherwise", () => {
    // The bug: `template = ".env.template"` was hardcoded into every config, in a repo
    // whose file is named .env.example. kit then pointed at a path that does not exist.
    const withTemplate = gen(stack({ services: ["supabase"] }), {
      secretsStore: "infisical",
      envTemplateFile: ".env.example",
    });
    assert.ok(withTemplate.includes('template = ".env.example"'), withTemplate);

    const without = gen(stack({ services: ["supabase"] }), { secretsStore: "infisical" });
    assert.ok(!without.includes("template ="), `no template line without a file: ${without}`);
  });

  it("omits setup.install when no package manager is evidenced", () => {
    // The bug: the fallback was `npm install`, which ran in a repo root that has no
    // package.json and left an empty package-lock.json behind.
    const { toml, gaps } = generateToml(stack({ language: "typescript", tools: { node: "22" } }));

    assert.ok(!toml.includes("install ="), `install must not be assumed: ${toml}`);
    const gap = gapFor(gaps, "setup.install");
    assert.ok(gap, `expected a setup.install gap, got: ${JSON.stringify(gaps)}`);
    assert.match(gap.why, /lock/i, "the gap should say what evidence was missing");
  });

  it("keeps install commands that a lockfile or the language itself determines", () => {
    // Not a guess: bun.lock in the tree, and `go mod download` is what Go IS.
    assert.ok(gen(stack({ tools: { bun: "1.3.10" } })).includes('install = "bun install"'));
    assert.ok(gen(stack({ language: "go", tools: { go: "1.22" } })).includes("go mod download"));
  });

  it("reports no gaps when everything is either proven or supplied", () => {
    const { gaps } = generateToml(stack({ tools: { bun: "1.3.10" }, services: ["convex"] }), {
      secretsStore: "infisical",
      verify: "bun run typecheck",
      envTemplateFile: ".env.example",
    });
    assert.deepEqual(gaps, [], `expected a clean run, got: ${JSON.stringify(gaps)}`);
  });
});

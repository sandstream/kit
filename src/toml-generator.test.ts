import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateToml } from "./toml-generator.js";
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

describe("generateToml", () => {
  it("generates valid TOML for a minimal stack", () => {
    const toml = generateToml(stack());
    // Should parse without throwing
    const parsed = parseTOML(toml);
    assert.ok(parsed, "should produce parseable TOML");
  });

  it("includes node version in [tools]", () => {
    const toml = generateToml(stack({ tools: { node: "22", pnpm: "latest" } }));
    assert.ok(toml.includes('node = "22"'), `missing node in: ${toml}`);
    assert.ok(toml.includes('pnpm = "latest"'), `missing pnpm in: ${toml}`);
  });

  it("includes the default security scanners (semgrep + socket + trufflehog) as mise tools", () => {
    const parsed = parseTOML(generateToml(stack())) as { tools: Record<string, string> };
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
    const without = parseTOML(generateToml(stack())) as { tools: Record<string, string> };
    assert.ok(!without.tools["aqua:aquasecurity/trivy"], "no trivy without a Dockerfile");
    const withDocker = parseTOML(generateToml(stack(), { hasDockerfile: true })) as { tools: Record<string, string> };
    assert.equal(withDocker.tools["aqua:aquasecurity/trivy"], "latest", "trivy provisioned with a Dockerfile");
  });

  it("provisions pip-audit for Python and osv-scanner for non-node ecosystems (not for node)", () => {
    const node = parseTOML(generateToml(stack({ language: "typescript" }))) as { tools: Record<string, string> };
    assert.ok(!node.tools["aqua:google/osv-scanner"], "no osv for node (npm audit covers it)");
    assert.ok(!node.tools["pipx:pip-audit"], "no pip-audit for node");

    const python = parseTOML(generateToml(stack({ language: "python", tools: {} }))) as { tools: Record<string, string> };
    assert.equal(python.tools["pipx:pip-audit"], "latest", "pip-audit for python");
    assert.ok(!python.tools["aqua:google/osv-scanner"], "no osv for python (pip-audit covers it)");

    const go = parseTOML(generateToml(stack({ language: "go", tools: {} }))) as { tools: Record<string, string> };
    assert.equal(go.tools["aqua:google/osv-scanner"], "latest", "osv-scanner for go (no dedicated scanner)");
  });

  it("provisions the chosen vault's CLI into [tools] (mise-installable backends)", () => {
    const infisical = parseTOML(
      generateToml(stack({ services: ["supabase"] }), { secretsStore: "infisical" }),
    ) as { tools: Record<string, string> };
    assert.equal(infisical.tools.infisical, "latest", "infisical CLI should be provisioned");

    const doppler = parseTOML(
      generateToml(stack({ services: ["supabase"] }), { secretsStore: "doppler" }),
    ) as { tools: Record<string, string> };
    assert.equal(doppler.tools.doppler, "latest", "doppler CLI should be provisioned");

    const vault = parseTOML(
      generateToml(stack({ services: ["supabase"] }), { secretsStore: "vault" }),
    ) as { tools: Record<string, string> };
    assert.equal(vault.tools.vault, "latest", "vault CLI should be provisioned");
  });

  it("does not provision a CLI for env or cloud-managed backends (aws/gcp/azure)", () => {
    const env = parseTOML(
      generateToml(stack({ services: ["supabase"] }), { secretsStore: "env" }),
    ) as { tools: Record<string, string> };
    // env: nothing vault-y; cloud SMs ship their CLI via the cloud env, not mise.
    const awsSm = parseTOML(
      generateToml(stack({ services: ["supabase"] }), { secretsStore: "aws-sm" }),
    ) as { tools: Record<string, string> };
    assert.ok(!awsSm.tools.aws && !awsSm.tools["aws-sm"], "no aws CLI provisioned for aws-sm");
    assert.ok(env.tools, "env still has a tools table (scanners etc.)");
  });

  it("scaffolds a [secrets.infisical] binding block when infisical is chosen", () => {
    const toml = generateToml(stack({ services: ["supabase", "stripe"] }), { secretsStore: "infisical" });
    assert.ok(toml.includes("[secrets.infisical]"), `missing binding block: ${toml}`);
    const parsed = parseTOML(toml) as { secrets: { infisical?: { environment?: string } } };
    assert.equal(parsed.secrets.infisical?.environment, "dev", "binding should default environment to dev");
    // No binding block for a non-infisical store.
    const op = generateToml(stack({ services: ["supabase"] }), { secretsStore: "1password" });
    assert.ok(!op.includes("[secrets.infisical]"), "1password config must not carry an infisical block");
  });

  it("generates Next.js + Supabase + Stripe config", () => {
    const s = stack({
      framework: "nextjs",
      services: ["supabase", "stripe"],
      tools: { node: "22", pnpm: "latest", supabase: "latest", stripe: "latest" },
    });
    const toml = generateToml(s);
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
    const toml = generateToml(s);
    assert.ok(toml.includes("[setup]"), "missing setup section");
    assert.ok(toml.includes("pnpm install"), `expected pnpm install in: ${toml}`);
  });

  it("generates supabase db push migrate command when supabase detected", () => {
    const s = stack({
      framework: "nextjs",
      services: ["supabase"],
      tools: { node: "22", pnpm: "latest" },
    });
    const toml = generateToml(s);
    assert.ok(toml.includes("supabase db push"), `expected migrate cmd: ${toml}`);
  });

  it("generates Python FastAPI config", () => {
    const s = stack({
      language: "python",
      framework: "fastapi",
      services: [],
      tools: { python: "3.12", uv: "latest" },
    });
    const toml = generateToml(s);
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
    const toml = generateToml(s);
    const parsed = parseTOML(toml);
    assert.ok(parsed, "valid TOML");
    assert.ok(toml.includes('go = "1.22"'), `missing go version: ${toml}`);
    assert.ok(toml.includes("go mod download"), `expected install cmd: ${toml}`);
  });

  it("includes comment header with detected stack", () => {
    const s = stack({ framework: "nextjs", services: ["stripe"] });
    const toml = generateToml(s);
    assert.ok(toml.includes("# .kit.toml"), "missing header comment");
    assert.ok(toml.includes("nextjs"), `missing framework in header: ${toml}`);
  });

  it("adds service tool to [tools] section when not already present", () => {
    const s = stack({
      framework: "nextjs",
      services: ["stripe"],
      tools: { node: "22", pnpm: "latest" },
    });
    const toml = generateToml(s);
    // stripe CLI tool should be added automatically
    assert.ok(toml.includes("stripe"), `expected stripe tool: ${toml}`);
  });

  it("generates no secrets section when no services detected", () => {
    const s = stack({ framework: "express", services: [], tools: { node: "22" } });
    const toml = generateToml(s);
    // secrets section should be absent or empty
    const parsed = parseTOML(toml) as Record<string, unknown>;
    assert.ok(!parsed.secrets, "should not have secrets when no services");
  });
});

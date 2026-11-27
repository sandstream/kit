import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { kitConfig, SecretKeyConfig } from "./config.js";
import { EVIDENCE_LIMIT, evidencePlan } from "./secrets-evidence-plan.js";
import { runSecretsIncident, type IncidentDeps } from "./secrets-incident-cli.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const SINCE = "2026-11-20T00:00:00Z";
const FAKE_VALUE = "fakevalue-evidence-9c1d";

/** The vendor pages each command was checked against (read 2026-11-27). */
const SOURCES = {
  "aws-sm":
    "https://docs.aws.amazon.com/secretsmanager/latest/userguide/monitoring-cloudtrail.html",
  kms: "https://docs.aws.amazon.com/kms/latest/developerguide/ct-decrypt.html",
  "gcp-sm": "https://docs.cloud.google.com/secret-manager/docs/audit-logging",
  "azure-kv": "https://learn.microsoft.com/en-us/azure/key-vault/general/monitor-key-vault",
  "1password": "https://www.1password.dev/events-api/reference/",
  infisical: "https://infisical.com/docs/api-reference/endpoints/audit-logs/export-audit-log",
};

function plan(cfg: SecretKeyConfig) {
  return evidencePlan("DEMO_KEY", cfg, SINCE);
}

describe("evidencePlan: verified store queries", () => {
  it("aws-sm: CloudTrail lookups for GetSecretValue and KMS Decrypt, with the 90-day limit", () => {
    const [sm, kms, kit] = plan({ source: "aws-sm", name: "prod/demo", aws_region: "eu-west-1" });
    assert.equal(
      sm!.command,
      "aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue='prod/demo' --start-time 2026-11-20T00:00:00Z --region eu-west-1 --query 'Events[?EventName=='\\''GetSecretValue'\\'']'",
    );
    assert.equal(sm!.source, SOURCES["aws-sm"]);
    assert.ok(sm!.caveats.some((c) => c.includes("last 90 days") && c.includes("trail")));
    assert.match(kms!.command!, /AttributeValue='<kms-key-arn>'.*Decrypt/);
    assert.equal(kms!.source, SOURCES.kms);
    assert.equal(kit!.command, `kit audit secrets --key DEMO_KEY --since ${SINCE}`);
  });

  it("gcp-sm: the AccessSecretVersion Data Access query, and that those logs are off by default", () => {
    const [step] = plan({ source: "gcp-sm", gcp_project: "demo-project" });
    assert.match(
      step!.command!,
      /^gcloud logging read '.*SecretManagerService\.AccessSecretVersion/,
    );
    assert.match(step!.command!, /resourceName:"\/secrets\/DEMO_KEY\/".*--project demo-project$/);
    assert.equal(step!.source, SOURCES["gcp-sm"]);
    assert.ok(
      step!.caveats[0]!.includes("disabled by default for all services except some BigQuery"),
    );
  });

  it("azure-kv: the SecretGet AuditEvent query, and that a diagnostic setting must route it", () => {
    const [step] = plan({ source: "azure-kv", azure_vault: "demo-vault" });
    assert.match(step!.command!, /AzureDiagnostics .*OperationName == "SecretGet"/);
    assert.match(step!.command!, /datetime\(2026-11-20T00:00:00Z\)/);
    assert.equal(step!.source, SOURCES["azure-kv"]);
    assert.ok(step!.caveats.some((c) => c.includes("diagnostic setting")));
  });

  it("1Password and Infisical: their documented audit endpoints", () => {
    const [op] = plan({ source: "1password", ref: "op://Demo/item/field" });
    assert.match(op!.command!, /POST <events-api-base-url>\/api\/v2\/itemusages/);
    assert.match(op!.command!, /"start_time":"2026-11-20T00:00:00Z"/);
    assert.equal(op!.source, SOURCES["1password"]);
    const [inf] = plan({ source: "infisical" });
    assert.match(
      inf!.command!,
      /\/api\/v1\/organization\/audit-logs\?eventType=get-secret&startDate=/,
    );
    assert.equal(inf!.source, SOURCES.infisical);
  });
});

describe("evidencePlan: no command it could not verify", () => {
  for (const source of ["vault", "doppler", "bitwarden"] as const) {
    it(`${source}: no command, marked not verified`, () => {
      const [step, kit] = plan({ source });
      assert.equal(step!.command, null);
      assert.equal(step!.verified, false);
      assert.match(step!.caveats[0]!, /^Not verified/);
      assert.equal(kit!.service, "kit audit chain");
    });
  }

  it("env and config keys: no store-side record, assume read", () => {
    for (const source of ["env", "config"] as const) {
      const [step] = plan({ source });
      assert.equal(step!.command, null);
      assert.match(step!.caveats[0]!, /assume it was read/);
    }
  });
});

describe("kit secrets incident prints the evidence plan", () => {
  const config: kitConfig = {
    secrets: {
      store: "aws-sm",
      keys: { DEMO_KEY: { source: "aws-sm", name: "prod/demo", aws_region: "eu-west-1" } },
    },
  };

  function run(args: string[]) {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "kit-evidence-")));
    execFileSync("git", ["init", "-q"], { cwd });
    writeFileSync(join(cwd, ".gitignore"), ".kit/*\n.kit-audit.jsonl\n");
    const lines: string[] = [];
    const deps: IncidentDeps = {
      cwd,
      keyRoot: join(cwd, "..", `${cwd.split(/[\\/]/).pop()}-keys`),
      read: async () => FAKE_VALUE,
      resolveCli: async () => ({ tool: "aws", path: "/opt/fake/aws", label: "/opt/fake/aws" }),
      checkCliIdentity: async () => ({ state: "unpinned", detail: "test" }),
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    };
    const done = runSecretsIncident(["aws-sm", ...args], config, deps).finally(() => {
      rmTemp(cwd);
      rmTemp(deps.keyRoot);
    });
    return { lines, done };
  }

  it("next to the rotation plan: store query, kit chain query and the limit, no value", async () => {
    const { lines, done } = await Promise.resolve(run(["--since", SINCE]));
    assert.equal(await done, true);
    const text = lines.join("\n");
    assert.match(text, /Evidence plan.*printed only; kit runs none of these/);
    assert.ok(text.includes(EVIDENCE_LIMIT));
    assert.ok(text.includes("aws cloudtrail lookup-events"));
    assert.ok(text.includes(`kit audit secrets --key DEMO_KEY --since ${SINCE}`));
    assert.ok(!text.includes(FAKE_VALUE));
  });

  it("refuses a --since that is not ISO 8601", async () => {
    const { lines, done } = run(["--since", "last week"]);
    assert.equal(await done, false);
    assert.match(lines.join("\n"), /--since takes an ISO 8601 date/);
  });
});

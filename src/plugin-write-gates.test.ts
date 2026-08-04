/**
 * Every mutating surface in every `kit-plugin-*` package is gated, by the RIGHT op, in the right
 * order — and a new one cannot ship without appearing here.
 *
 * WHY THIS EXISTS. `kit-plugin-supabase` shipped three write surfaces with no containment guard at
 * all: `rollJwtSecret`, `revokeScopedKey`, `mintScopedKey`. Measured before the fix, with
 * `KIT_READ_ONLY=1` set in the process and the client pointed at a local listener, all three sent
 * their request and `rollJwtSecret` returned a rolled secret — the op kit's own registry describes
 * as "invalidates EVERY existing token". Six sibling plugins had the guard; the one holding the most
 * catastrophic op did not, and every document that said "every kit-plugin write surface is honored"
 * was wrong for the surface that mattered most.
 *
 * Nothing could have caught that: the guard was a convention, and a convention is enforced by
 * whoever remembers it. So this test derives the write surfaces from the SOURCE rather than from a
 * list someone maintains — any function issuing a mutating HTTP request must appear in the mapping
 * below with both guards — which means the failure mode that bit us (a new surface, quietly
 * ungated) fails a test instead of shipping.
 *
 * It pins the MAPPING, not merely the presence of a call. `assertPolicyAllows("cloudflare",
 * "env_set")` on the token-revoke surface would satisfy a presence check while pre-approving an
 * env-var write silently authorised revoking a live credential.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { knownPolicyOps } from "./policy-gate.js";

const PACKAGES = resolve(import.meta.dirname, "..", "packages");

/** plugin → the mutating surfaces it exposes, and the op each one must ask about. */
const EXPECTED: Record<string, { fn: string; vendor: string; op: string }[]> = {
  vercel: [
    { fn: "createEnvVar", vendor: "vercel", op: "env_set" },
    { fn: "deleteEnvVar", vendor: "vercel", op: "env_unset" },
    { fn: "updateEnvVar", vendor: "vercel", op: "env_set" },
    { fn: "redeployLatest", vendor: "vercel", op: "trigger_deploy" },
  ],
  github: [
    { fn: "createOrUpdateRepoSecret", vendor: "github", op: "env_set" },
    { fn: "deleteRepoSecret", vendor: "github", op: "env_unset" },
  ],
  fly: [
    { fn: "setAppSecrets", vendor: "fly", op: "env_set" },
    { fn: "unsetAppSecrets", vendor: "fly", op: "env_unset" },
  ],
  cloudflare: [
    { fn: "putWorkerSecret", vendor: "cloudflare", op: "env_set" },
    { fn: "deleteWorkerSecret", vendor: "cloudflare", op: "env_unset" },
    { fn: "revokeApiToken", vendor: "cloudflare", op: "api_token_revoke" },
  ],
  stripe: [
    { fn: "createWebhookEndpoint", vendor: "stripe", op: "webhook_create" },
    { fn: "deleteWebhookEndpoint", vendor: "stripe", op: "webhook_delete" },
  ],
  sentry: [
    { fn: "updateIssue", vendor: "sentry", op: "resolve_issue" },
    { fn: "createRelease", vendor: "sentry", op: "create_release" },
  ],
  supabase: [
    { fn: "rollJwtSecret", vendor: "supabase", op: "jwt_secret_roll" },
    { fn: "revokeScopedKey", vendor: "supabase", op: "scoped_key_revoke" },
    { fn: "mintScopedKey", vendor: "supabase", op: "scoped_key_mint" },
  ],
};

/**
 * Functions that issue a non-GET request WITHOUT mutating vendor state, each with the reason.
 *
 * An exemption must be written down here, which makes granting one a deliberate reviewable act
 * rather than the silence that let the Supabase surfaces through. Every entry is asserted to still
 * match something, so the list cannot rot into a set of names that stopped existing while quietly
 * exempting whatever is called that today.
 *
 * Two distinct reasons appear, and the difference matters: a request that is READ-SHAPED (a GraphQL
 * query, an OAuth grant) is not a write at all, whereas a shared TRANSPORT does carry writes — its
 * mutating callers are gated instead. Exempting a transport is why the second detector below exists:
 * the POST lives in the transport, so a new mutation routed through it would otherwise be invisible.
 */
const NON_MUTATING_NON_GET: Record<string, string> = {
  "fly/gql":
    "shared GraphQL transport — the mutating callers (setAppSecrets, unsetAppSecrets) gate",
  "wiz/makeClient": "OAuth client-credentials grant — the POST obtains a token, it writes nothing",
  "wiz/fetchIssues": "GraphQL read — the query travels in a POST body",
  "sentry/postIssueComment":
    "internal helper reached only from updateIssue, which is gated before it runs",
};

function pluginSources(): { plugin: string; file: string; src: string }[] {
  const out: { plugin: string; file: string; src: string }[] = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("kit-plugin-")) continue;
    const plugin = entry.name.replace("kit-plugin-", "");
    const dir = resolve(PACKAGES, entry.name, "src");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      out.push({ plugin, file: f, src: readFileSync(resolve(dir, f), "utf8") });
    }
  }
  return out;
}

/** The function (exported or not) whose body contains `index`. */
function enclosingFunction(src: string, index: number): string | null {
  const decls = [...src.matchAll(/^(?:export )?async function (\w+)/gm)];
  let name: string | null = null;
  for (const d of decls) {
    if (d.index! < index) name = d[1]!;
    else break;
  }
  return name;
}

describe("every mutating plugin surface is gated", () => {
  it("each expected surface asserts read-only THEN policy, with its own op", () => {
    for (const [plugin, surfaces] of Object.entries(EXPECTED)) {
      const path = resolve(PACKAGES, `kit-plugin-${plugin}`, "src", "mgmt-api.ts");
      const src = readFileSync(path, "utf8");
      for (const { fn, vendor, op } of surfaces) {
        const start = src.search(new RegExp(`export async function ${fn}\\b`));
        assert.notEqual(start, -1, `${plugin}: ${fn} not found`);
        const head = src.slice(start, start + 900);
        const ro = head.indexOf(`assertNotReadOnly("${plugin}/${fn}")`);
        const pol = head.indexOf(`assertPolicyAllows("${vendor}", "${op}")`);
        assert.ok(ro !== -1, `${plugin}/${fn} is missing its read-only guard`);
        assert.ok(
          pol !== -1,
          `${plugin}/${fn} is missing assertPolicyAllows("${vendor}", "${op}") — a write surface with no policy choke point is what the Supabase measurement found`,
        );
        // Order matters for the operator's error message, not for safety: a locked-down repo must
        // answer "read-only" rather than "your policy is missing an entry", which would send them
        // editing config to fix a lock that config cannot open. Same ordering `propagate()` uses.
        assert.ok(
          ro < pol,
          `${plugin}/${fn}: the read-only guard must come first, or a locked repo blames the policy`,
        );
      }
    }
  });

  it("every op a plugin asks about is in the registry", () => {
    const known = knownPolicyOps();
    for (const [plugin, surfaces] of Object.entries(EXPECTED)) {
      for (const { vendor, op } of surfaces) {
        assert.ok(
          known.has(`${vendor}:${op}`),
          `${plugin} gates on ${vendor}:${op}, which POLICY_OPS does not contain — the operator would have no line they could write to pre-approve it, so the op would be refusable but never approvable`,
        );
      }
    }
  });

  it("no mutating request escapes the mapping — including in a plugin nobody thought to check", () => {
    const expectedFns = new Set(
      Object.entries(EXPECTED).flatMap(([plugin, s]) => s.map((x) => `${plugin}/${x.fn}`)),
    );
    const ungated: string[] = [];
    const matched = new Set<string>();
    for (const { plugin, file, src } of pluginSources()) {
      // Detector 1 — the request itself is a mutation.
      const hits: { fn: string | null; what: string }[] = [];
      for (const m of src.matchAll(/method:\s*"(POST|PUT|PATCH|DELETE)"/g)) {
        hits.push({ fn: enclosingFunction(src, m.index!), what: m[1]! });
      }
      // Detector 2 — a GraphQL mutation, whose HTTP verb lives in a shared transport several frames
      // away. Without this, exempting `fly/gql` would exempt every future write routed through it:
      // `setAppSecrets` contains no `method:` of its own, only the word `mutation`.
      for (const m of src.matchAll(/`\s*mutation\s+\w+/g)) {
        hits.push({ fn: enclosingFunction(src, m.index!), what: "graphql mutation" });
      }
      for (const { fn, what } of hits) {
        if (!fn) continue;
        const id = `${plugin}/${fn}`;
        if (id in NON_MUTATING_NON_GET) {
          matched.add(id);
          continue;
        }
        if (expectedFns.has(id)) continue;
        ungated.push(`${id} (${file}, ${what})`);
      }
    }
    assert.deepEqual(
      ungated,
      [],
      `these functions issue a mutating request but are in neither the gate mapping nor the documented exemptions: ${ungated.join(", ")}`,
    );
    // An exemption that no longer matches anything is worse than none: it looks like review happened
    // for a function that has since been renamed, while whatever replaced it goes unexamined.
    assert.deepEqual(
      Object.keys(NON_MUTATING_NON_GET).filter((k) => !matched.has(k)),
      [],
      "these documented exemptions matched nothing — a renamed or deleted function leaves a stale grant behind",
    );
  });

  it("the two guards are byte-identical across every plugin that has them", () => {
    // Seven copies of a five-line guard is the price of the zero-dependency plugin contract
    // (`adapter-sdk` explains why plugins must not import kit-core). Duplication is only tolerable
    // while the copies cannot drift — one plugin quietly loosening `KIT_READ_ONLY` to `=== "1"`
    // only, or reading a different env var, would be invisible in review.
    const readOnly = new Map<string, string[]>();
    const policy = new Map<string, string[]>();
    for (const { plugin, file, src } of pluginSources()) {
      for (const [re, into] of [
        [/function assertNotReadOnly\(operation: string\): void \{[\s\S]*?\n\}/, readOnly],
        [/function assertPolicyAllows\(vendor: string, op: string\): void \{[\s\S]*?\n\}/, policy],
      ] as const) {
        const m = re.exec(src);
        if (!m) continue;
        const key = m[0];
        into.set(key, [...(into.get(key) ?? []), `${plugin}/${file}`]);
      }
    }
    assert.equal(
      readOnly.size,
      1,
      `the read-only guard has ${readOnly.size} distinct implementations across the plugins: ${JSON.stringify([...readOnly.values()])}`,
    );
    assert.equal(
      policy.size,
      1,
      `the policy guard has ${policy.size} distinct implementations across the plugins: ${JSON.stringify([...policy.values()])}`,
    );
    // And it must be present in every plugin that has a write surface, not merely consistent
    // wherever it happens to appear.
    const withWrites = new Set(Object.keys(EXPECTED));
    assert.equal(
      [...policy.values()][0]!.length,
      withWrites.size,
      "one policy guard per write plugin",
    );
  });
});

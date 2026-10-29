import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectIndependentReviewComments } from "./review-comments-github.js";
import type { ReadCommand } from "./review-receipt-io.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const REPO = "sandstream/kit";
const NUMBER = 12;
const EXPECTED_ROOT = "/repo";

function comment(id: number, verdict: "pass" | "incomplete" | "findings") {
  const statuses = ["correctness", "security", "tests", "public-hygiene", "adr"].map((area) => ({
    area,
    status:
      verdict === "incomplete"
        ? "unverified"
        : verdict === "findings" && area === "security"
          ? "issue"
          : "pass",
    evidence: "Checked the relevant code",
  }));
  const report = {
    schema: "kit-independent-review/v1",
    repository: REPO,
    pull_request: NUMBER,
    head: HEAD,
    base_branch: "main",
    base_tip: BASE,
    base: MERGE_BASE,
    verdict,
    checks: statuses,
    limits: verdict === "incomplete" ? ["Tests could not run"] : [],
    findings:
      verdict === "findings"
        ? [
            {
              severity: "P1",
              file: "src/example.ts",
              line: 7,
              scenario: "Unsafe input",
              evidence: "Reproduced",
            },
          ]
        : [],
  };
  return {
    id,
    html_url: `https://github.com/${REPO}/pull/${NUMBER}#issuecomment-${id}`,
    user: { login: "reviewer", type: "User" },
    author_association: "MEMBER",
    created_at: "2026-10-29T00:00:00Z",
    updated_at: "2026-10-29T00:00:00Z",
    body: `<!-- kit-independent-review:v1 -->\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
  };
}

function state(head = HEAD, base = BASE, branch = "main") {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: NUMBER,
          headRefOid: head,
          baseRefName: branch,
          baseRef: { target: { oid: base } },
        },
      },
    },
  });
}

function fakeRun(
  options: {
    firstState?: string;
    lastState?: string;
    pages?: unknown;
    compare?: string;
    failComments?: boolean;
  } = {},
): { run: ReadCommand; calls: string[][] } {
  const calls: string[][] = [];
  let stateCalls = 0;
  const states = [options.firstState ?? state(), options.lastState ?? state()];
  const pages = options.pages ?? [[comment(1, "incomplete")], [comment(2, "pass")]];
  const comparison = options.compare ?? `${MERGE_BASE}\n`;
  const readPages = () => {
    if (options.failComments) throw new Error("GitHub failed on a page");
    return JSON.stringify(pages);
  };
  const run: ReadCommand = (cmd, args, cwd) => {
    assert.equal(cwd, EXPECTED_ROOT);
    assert.equal(cmd, "gh");
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") return states[stateCalls++]!;
    if (args[1] === "--paginate") return readPages();
    if (args.some((a) => a.includes("/compare/"))) return comparison;
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("collectIndependentReviewComments", () => {
  it("reads every page and chooses the newer report from the same author", () => {
    const { run, calls } = fakeRun();
    const result = collectIndependentReviewComments(EXPECTED_ROOT, REPO, NUMBER, HEAD, run);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.comment.id, "2");
    assert.equal(result[0]?.result.kind, "current");
    if (result[0]?.result.kind === "current") assert.equal(result[0].result.report.verdict, "pass");
    assert.ok(calls.some((args) => args.includes("--paginate") && args.includes("--slurp")));
    assert.ok(calls.some((args) => args.includes(`repos/${REPO}/compare/${BASE}...${HEAD}`)));
    assert.equal(calls.filter((args) => args[1] === "graphql").length, 2);
  });

  it("propagates pagination errors and rejects malformed pages and metadata", () => {
    assert.throws(
      () =>
        collectIndependentReviewComments(
          EXPECTED_ROOT,
          REPO,
          NUMBER,
          HEAD,
          fakeRun({ failComments: true }).run,
        ),
      /page/,
    );
    assert.throws(
      () =>
        collectIndependentReviewComments(
          EXPECTED_ROOT,
          REPO,
          NUMBER,
          HEAD,
          fakeRun({ pages: [null] }).run,
        ),
      /page/i,
    );
    assert.throws(
      () =>
        collectIndependentReviewComments(
          EXPECTED_ROOT,
          REPO,
          NUMBER,
          HEAD,
          fakeRun({ pages: [[{ ...comment(1, "pass"), user: {} }]] }).run,
        ),
      /author/i,
    );
  });
});

describe("collectIndependentReviewComments ignores unrelated comments", () => {
  it("retains reports and findings from deleted and present authors", () => {
    const pages = [
      [
        { ...comment(1, "findings"), user: null },
        { ...comment(2, "pass"), user: null },
      ],
      [comment(3, "findings")],
    ];
    const result = collectIndependentReviewComments(
      EXPECTED_ROOT,
      REPO,
      NUMBER,
      HEAD,
      fakeRun({ pages }).run,
    );
    assert.deepEqual(
      result.map((entry) => entry.comment.id),
      ["1", "2", "3"],
    );
    assert.equal(result[0]?.comment.author, "deleted-user-1");
    assert.equal(result[1]?.comment.author, "deleted-user-2");
    assert.equal(result[0]?.comment.authorMissing, true);
    assert.equal(result[1]?.comment.authorMissing, true);
    assert.equal(result[2]?.comment.author, "reviewer");
    assert.equal(result[2]?.comment.authorMissing, undefined);
    for (const entry of [result[0], result[2]]) {
      assert.equal(entry?.result.kind, "current");
      if (entry?.result.kind === "current") assert.equal(entry.result.report.findings.length, 1);
    }
  });

  it("keeps reports visible when an ordinary comment has a deleted author", () => {
    const pages = [
      [{ ...comment(1, "pass"), body: "A normal comment", user: null }, comment(2, "findings")],
    ];
    const result = collectIndependentReviewComments(
      EXPECTED_ROOT,
      REPO,
      NUMBER,
      HEAD,
      fakeRun({ pages }).run,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.comment.id, "2");
    assert.equal(result[0]?.result.kind, "current");
    if (result[0]?.result.kind === "current")
      assert.equal(result[0].result.report.findings.length, 1);
  });

  it("refuses a comment whose body is unavailable", () => {
    const pages = [[{ ...comment(1, "pass"), body: null }]];
    assert.throws(
      () =>
        collectIndependentReviewComments(EXPECTED_ROOT, REPO, NUMBER, HEAD, fakeRun({ pages }).run),
      /body/i,
    );
  });
});

describe("collectIndependentReviewComments rejects stale evidence", () => {
  it("refuses missing base and malformed comparison evidence", () => {
    const noBase = JSON.stringify({
      data: {
        repository: {
          pullRequest: { number: NUMBER, headRefOid: HEAD, baseRefName: "main", baseRef: null },
        },
      },
    });
    assert.throws(
      () =>
        collectIndependentReviewComments(
          EXPECTED_ROOT,
          REPO,
          NUMBER,
          HEAD,
          fakeRun({ firstState: noBase }).run,
        ),
      /base/i,
    );
    assert.throws(
      () =>
        collectIndependentReviewComments(
          EXPECTED_ROOT,
          REPO,
          NUMBER,
          HEAD,
          fakeRun({ compare: "not a commit" }).run,
        ),
      /merge base/i,
    );
  });

  it("refuses repository names that could alter an API path", () => {
    assert.throws(
      () => collectIndependentReviewComments(EXPECTED_ROOT, "../kit", NUMBER, HEAD, fakeRun().run),
      /identity/i,
    );
    assert.throws(
      () =>
        collectIndependentReviewComments(EXPECTED_ROOT, "owner/..", NUMBER, HEAD, fakeRun().run),
      /identity/i,
    );
  });

  it("refuses changed head, base branch, or live base tip during collection", () => {
    for (const lastState of [
      state("d".repeat(40)),
      state(HEAD, "e".repeat(40)),
      state(HEAD, BASE, "other"),
    ]) {
      assert.throws(
        () =>
          collectIndependentReviewComments(
            EXPECTED_ROOT,
            REPO,
            NUMBER,
            HEAD,
            fakeRun({ lastState }).run,
          ),
        /changed/i,
      );
    }
    assert.throws(
      () =>
        collectIndependentReviewComments(
          EXPECTED_ROOT,
          REPO,
          NUMBER,
          HEAD,
          fakeRun({ firstState: state("d".repeat(40)) }).run,
        ),
      /head/i,
    );
  });
});

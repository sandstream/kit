import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripComments, checkDesign } from "./check-design.js";

// The a11y/token scanners are line scanners over component sources — markup or
// raw values mentioned in comments/docstrings are documentation, not rendered
// UI, and must not produce findings (real case: a commented
// `<input type="datetime-local">` example flagged as an unlabeled input).

describe("stripComments", () => {
  it("blanks block comments (incl. JSX-wrapped) while preserving line numbers", () => {
    const src = `a\n{/* <input type="text"> */}\n/* one\ntwo */\nb`;
    const out = stripComments(src);
    assert.equal(out.split("\n").length, src.split("\n").length);
    assert.ok(!out.includes("<input"));
    assert.ok(!out.includes("two"));
    assert.ok(out.includes("a") && out.includes("b"));
  });

  it("blanks HTML comments (astro/vue templates)", () => {
    const out = stripComments(`x\n<!-- <img src="a.png"> -->\ny`);
    assert.ok(!out.includes("<img"));
    assert.equal(out.split("\n").length, 3);
  });

  it("blanks // line comments but keeps URLs", () => {
    const out = stripComments(`const u = "https://ex.com/p"; // #fff example\n<a href="x">`);
    assert.ok(out.includes("https://ex.com/p"), "URL must survive");
    assert.ok(!out.includes("#fff"), "comment tail must be blanked");
    assert.ok(out.includes(`<a href="x">`));
  });
});

describe("checkDesign comment awareness", () => {
  let tempDir: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-design-"));
    await mkdir(join(tempDir, "src"), { recursive: true });
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ignores markup and raw values inside comments; still flags the real thing", async () => {
    await writeFile(
      join(tempDir, "src", "form.tsx"),
      [
        "/**",
        ' * Docstring example: <input type="datetime-local"> — documentation only.',
        " */",
        "// commented style: color: #abcdef;",
        "export const Form = () => (",
        "  <form>",
        '    <input type="text" />', // the ONE real finding
        "  </form>",
        ");",
        "",
      ].join("\n"),
      "utf-8",
    );

    const results = await checkDesign({ srcRoots: ["src"] });
    const a11y = results.find((r) => r.name.startsWith("a11y"))!;
    const tokens = results.find((r) => r.name.startsWith("design-token"))!;

    // Exactly one a11y finding — the rendered unlabeled input on line 7, not
    // the docstring example on line 2.
    assert.equal(a11y.status, "warn");
    assert.match(a11y.detail, /1 new a11y finding/);
    assert.ok(
      a11y.files?.some((f) => f.includes("form.tsx:7")),
      `wrong line: ${a11y.files}`,
    );

    // The commented-out hex is prose, not a token bypass.
    assert.equal(tokens.status, "pass", `commented hex flagged: ${tokens.detail}`);
  });
});

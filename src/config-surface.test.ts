/**
 * The configuration reference must not be able to drift from the code, in either direction.
 *
 * A hand-written config reference rots silently: a section ships, nobody adds a paragraph, and the
 * document quietly describes an older kit. So the oracle here is `kitConfig` in `src/config.ts`
 * itself, scanned rather than copied.
 *
 * Both directions are errors, which is the difference from the flag surface:
 *
 *   - a section in the type and not in the table → the operator has no way to learn it exists;
 *   - an entry in the table that is not a section → the reader is sent to configure something kit
 *     will ignore, which is worse than silence.
 *
 * Measured before this existed: 23 sections, six of them (`tools`, `services`, `secrets`, `skills`,
 * `governance`, `hooks`) with no description anywhere in the type, and two (`mcp`, `supply_chain`)
 * appearing in no document at all.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONFIG_SECTIONS, configSectionNames } from "./config-surface.js";
import { KNOWN_SECTIONS } from "./config.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The section names `kitConfig` actually declares, read from the source. */
function sectionsInType(): string[] {
  const source = readFileSync(join(REPO_ROOT, "src", "config.ts"), "utf-8");
  const start = source.indexOf("export interface kitConfig {");
  assert.ok(start > 0, "kitConfig must exist — this test's oracle is the interface itself");
  const body = source.slice(start, start + source.slice(start).indexOf("\n}\n"));
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    // Top-level members only: two spaces of indent, then the name. Nested object literals inside a
    // section are indented further and must not be mistaken for sections.
    const m = /^ {2}([a-z_]+)\??:/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

describe("the declared configuration surface", () => {
  it("describes every section kitConfig accepts", () => {
    const missing = sectionsInType().filter((s) => !CONFIG_SECTIONS[s]);
    assert.deepEqual(
      missing,
      [],
      `${missing.length} section(s) exist in kitConfig with no entry in config-surface.ts — ` +
        `an operator cannot discover a section nobody described: ${missing.join(", ")}`,
    );
  });

  it("describes nothing kit does not accept", () => {
    const inType = new Set(sectionsInType());
    const stale = configSectionNames().filter((s) => !inType.has(s));
    assert.deepEqual(
      stale,
      [],
      `${stale.length} entr(y/ies) describe a section kitConfig no longer has, which sends the ` +
        `reader to configure something kit will ignore: ${stale.join(", ")}`,
    );
  });

  it("says what each section buys, not just what it is called", () => {
    for (const [name, section] of Object.entries(CONFIG_SECTIONS)) {
      assert.ok(section.purpose.length > 20, `${name}: purpose is too thin to be useful`);
      assert.ok(section.buys.length > 30, `${name}: "buys" must give a reason to care`);
      // A restatement of the name is not a reason. Cheap proxy: the reason must not be a prefix of
      // the purpose, and must not simply repeat the section name back.
      assert.notEqual(section.buys, section.purpose, `${name}: buys repeats purpose`);
      assert.ok(
        section.example.includes(name) || section.example.includes("version"),
        `${name}: the example must show the section it documents`,
      );
    }
  });

  it("points every named doc and command at something that exists", () => {
    // Every doc, not just COMMANDS.md: `kit bootstrap` is human-facing and lives only in
    // docs/ENV_FUELING.md, which the `undocumented commands` self-audit rule accepts — so
    // narrowing this to COMMANDS.md would fail on a command that is genuinely documented.
    const commands = readdirSync(join(REPO_ROOT, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        try {
          return readFileSync(join(REPO_ROOT, "docs", f), "utf-8");
        } catch {
          return "";
        }
      })
      .join("\n");
    for (const [name, section] of Object.entries(CONFIG_SECTIONS)) {
      if (section.docs) {
        assert.ok(
          (() => {
            try {
              readFileSync(join(REPO_ROOT, section.docs!), "utf-8");
              return true;
            } catch {
              return false;
            }
          })(),
          `${name}: docs points at ${section.docs}, which does not exist`,
        );
      }
      if (section.command) {
        // The verb must be a real command — the same claim `documented commands` enforces for docs.
        const verb = section.command.split(" ")[1];
        assert.ok(
          commands.includes(`kit ${verb}`),
          `${name}: command \`${section.command}\` names a verb absent from every doc`,
        );
      }
    }
  });
});

/**
 * The generated reference must be byte-identical to what the generator produces.
 *
 * Same property as `flag-surface.test.ts`, for the same reason: a generated file that cannot be
 * regenerated without noise is a file nobody regenerates, and then the "generated" header is a lie.
 * Learned the hard way — a formatting-only 512-line diff was misread as data loss and reported as a
 * defect.
 */
describe("docs/CONFIGURATION.md", () => {
  it("is exactly what the generator emits", async () => {
    const mod = (await import(
      pathToFileURL(join(REPO_ROOT, "scripts", "gen-config-doc.mjs")).href
    )) as { render: () => Promise<string> };
    const generated = await mod.render();
    const committed = readFileSync(join(REPO_ROOT, "docs", "CONFIGURATION.md"), "utf-8");
    if (generated !== committed) {
      const g = generated.split("\n");
      const c = committed.split("\n");
      const i = g.findIndex((line, idx) => line !== c[idx]);
      assert.fail(
        `line ${i + 1} differs — run \`node scripts/gen-config-doc.mjs\`\n` +
          `  generated: ${JSON.stringify(g[i])}\n  committed: ${JSON.stringify(c[i])}`,
      );
    }
  });

  it("links only to documents that exist", () => {
    const text = readFileSync(join(REPO_ROOT, "docs", "CONFIGURATION.md"), "utf-8");
    for (const target of new Set(
      [...text.matchAll(/\]\(([A-Za-z0-9_]+\.md)\)/g)].map((m) => m[1]),
    )) {
      assert.ok(
        readdirSync(join(REPO_ROOT, "docs")).includes(target),
        `CONFIGURATION.md links to docs/${target}, which does not exist`,
      );
    }
  });
});

/**
 * The THIRD list, which nothing was checking.
 *
 * A section is declared in three places: the `kitConfig` type, `CONFIG_SECTIONS` (this file's
 * subject), and `KNOWN_SECTIONS` in config.ts — the typo detector `loadConfig` warns from. The
 * first two were pinned to each other; the third was not, and it had drifted: `[supply_chain]` and
 * `[coverage]` are real sections kit reads and honours, and declaring either printed
 *
 *     Warning: unknown section [coverage] in .kit.toml (known: …)
 *
 * on every single kit invocation in that repo. A warning that fires on correct configuration is
 * worse than no warning: it teaches the operator to ignore the one that fires on a genuine typo.
 *
 * Pinned in BOTH directions, like the surface test above — an entry here that is not a real
 * section sends the reader looking for something kit will ignore.
 */
describe("KNOWN_SECTIONS (config.ts) and the declared surface", () => {
  it("are the same set of sections", () => {
    const surface = Object.keys(CONFIG_SECTIONS).sort();
    const known = [...KNOWN_SECTIONS].sort();
    assert.deepEqual(
      known,
      surface,
      "a section kit honours must not warn as a typo, and a section it warns about must be real",
    );
  });
});

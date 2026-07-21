import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderObsidianVault, slugify } from "./obsidian.js";
import type { SharedEntry } from "./shared.js";

const mk = (over: Partial<SharedEntry>): SharedEntry => ({
  id: over.id ?? "a1b2c3",
  area: over.area ?? "auth",
  kind: over.kind ?? "decision",
  title: over.title ?? "Use Ed25519",
  body: over.body ?? "platform signing keys",
  refs: over.refs ?? [],
  author: over.author ?? "peter",
  ts: over.ts ?? "2026-06-01T00:00:00Z",
  ...over,
});

describe("obsidian export (J3)", () => {
  it("slugify is filesystem-safe and bounded", () => {
    assert.equal(slugify("Use Ed25519 / RSA!"), "use-ed25519-rsa");
    assert.equal(slugify(""), "untitled");
    assert.equal(slugify("!!!"), "untitled");
  });

  it("renders one note per entry plus a per-area index", () => {
    const files = renderObsidianVault([
      mk({ id: "e1", area: "auth", title: "A" }),
      mk({ id: "e2", area: "billing", title: "B" }),
    ]);
    const paths = files.map((f) => f.path).sort();
    assert.ok(paths.includes("auth/_index.md"));
    assert.ok(paths.includes("billing/_index.md"));
    assert.ok(paths.some((p) => p.startsWith("auth/decision-e1-")));
    assert.ok(paths.some((p) => p.startsWith("billing/decision-e2-")));
    assert.equal(files.length, 4); // 2 notes + 2 indexes
  });

  it("note carries YAML frontmatter (id/area/kind/status/tags) and an H1 title", () => {
    const [note] = renderObsidianVault([mk({ id: "e1", title: "Use Ed25519" })]);
    assert.match(note.content, /^---\n/);
    assert.match(note.content, /\nid: e1\n/);
    assert.match(note.content, /\nkind: decision\n/);
    assert.match(note.content, /\nstatus: active\n/);
    assert.match(note.content, /kit\/area\/auth/);
    assert.match(note.content, /\n# Use Ed25519\n/);
  });

  it("supersede relation renders as an Obsidian wikilink to the target note", () => {
    const files = renderObsidianVault([
      mk({ id: "old", title: "Old RSA" }),
      mk({ id: "new", title: "New Ed25519", supersedes: "old" }),
    ]);
    const newNote = files.find((f) => f.path.includes("decision-new-"))!;
    assert.match(newNote.content, /Supersedes \[\[decision-old-old-rsa\]\]/);
    // and the superseded entry's own note reflects the effective status
    const oldNote = files.find((f) => f.path.includes("decision-old-"))!;
    assert.match(oldNote.content, /\nstatus: superseded\n/);
  });

  it("a missing relation target degrades gracefully (no crash, marked missing)", () => {
    const [note] = renderObsidianVault([mk({ id: "e1", reverses: "ghost" })]);
    assert.match(note.content, /Reverses `ghost` \(missing\)/);
  });

  it("is deterministic — identical input yields identical output", () => {
    const input = [mk({ id: "e2", area: "b" }), mk({ id: "e1", area: "a" })];
    assert.deepEqual(renderObsidianVault(input), renderObsidianVault(input));
  });

  it("empty tier → no files", () => {
    assert.deepEqual(renderObsidianVault([]), []);
  });
});

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DocumentationGenerator,
  type APIDoc,
  type Example,
  type Tutorial,
} from "./documentation-generator.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAPIDoc(endpoint: string, overrides: Partial<APIDoc> = {}): APIDoc {
  return {
    endpoint,
    method: "GET",
    description: "API endpoint",
    parameters: [],
    response: { type: "object", example: {} },
    errors: [],
    ...overrides,
  };
}

function makeExample(id: string, overrides: Partial<Example> = {}): Example {
  return {
    id,
    title: "Example Title",
    description: "Example description",
    language: "typescript",
    code: "const x = 1;",
    explanation: "This is an explanation",
    tags: ["basic"],
    difficulty: "beginner",
    runnable: true,
    ...overrides,
  };
}

function makeTutorial(id: string, overrides: Partial<Tutorial> = {}): Tutorial {
  return {
    id,
    title: "Tutorial Title",
    description: "Tutorial description",
    steps: [
      {
        title: "Step 1",
        content: "Do this",
        expectedOutcome: "You should see X",
      },
    ],
    estimatedTime: 30,
    difficulty: "beginner",
    prerequisites: [],
    relatedDocs: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DocumentationGenerator", () => {
  describe("initialization", () => {
    it("creates generator instance", () => {
      const gen = new DocumentationGenerator();
      assert(gen);
    });

    it("starts with empty caches", () => {
      const gen = new DocumentationGenerator();
      assert.equal(gen.getPagesCache().size, 0);
      assert.equal(gen.getExamplesCache().size, 0);
      assert.equal(gen.getTutorialsCache().size, 0);
      assert.equal(gen.getAPIDocsCache().size, 0);
    });
  });

  describe("page creation", () => {
    let gen: DocumentationGenerator;

    beforeEach(() => {
      gen = new DocumentationGenerator();
    });

    it("creates a documentation page", () => {
      const page = gen.createPage("Getting Started", "# Content", "guide", "author-1");
      assert(page.id);
      assert.equal(page.title, "Getting Started");
      assert.equal(page.type, "guide");
    });

    it("generates slug from title", () => {
      const page = gen.createPage("Getting Started", "Content", "guide", "author-1");
      assert.equal(page.slug, "getting-started");
    });

    it("generates table of contents", () => {
      const content = "# Heading 1\n## Heading 2\n### Heading 3";
      const page = gen.createPage("Test", content, "guide", "author-1");
      assert(page.toc);
      assert(page.toc.length === 3);
    });

    it("tracks page views", () => {
      const created = gen.createPage("Test", "Content", "guide", "author-1");
      const page = gen.getPage(created.id);
      assert.equal(page?.views, 1);
      gen.getPage(created.id);
      assert.equal(page?.views, 2);
    });

    it("updates a page", () => {
      const created = gen.createPage("Test", "Content", "guide", "author-1");
      const updated = gen.updatePage(created.id, { content: "New content" });
      assert.equal(updated?.content, "New content");
    });

    it("deletes a page", () => {
      const created = gen.createPage("Test", "Content", "guide", "author-1");
      const deleted = gen.deletePage(created.id);
      assert(deleted);
      assert.equal(gen.getPage(created.id), null);
    });

    it("returns null for unknown page", () => {
      const page = gen.getPage("unknown");
      assert.equal(page, null);
    });
  });

  describe("search & indexing", () => {
    let gen: DocumentationGenerator;

    beforeEach(() => {
      gen = new DocumentationGenerator();
      gen.createPage("Stripe Integration", "How to integrate Stripe payments", "guide", "author-1");
      gen.createPage("Payment Methods", "Supported payment methods", "api", "author-1");
      gen.createPage("Getting Started", "Start building", "guide", "author-1");
    });

    it("searches by keyword", () => {
      const results = gen.search("stripe");
      assert(results.length > 0);
      assert(results.some((r) => r.page.title.includes("Stripe")));
    });

    it("returns search results with snippets", () => {
      const results = gen.search("payment");
      assert(results.every((r) => r.snippet.length > 0));
    });

    it("ranks by relevance", () => {
      const results = gen.search("payment");
      if (results.length > 1) {
        assert(results[0].relevance >= results[1].relevance);
      }
    });

    it("respects search limit", () => {
      const results = gen.search("guide", 5);
      assert(results.length <= 5);
    });

    it("returns empty for unknown search", () => {
      const results = gen.search("nonexistent");
      assert.equal(results.length, 0);
    });
  });

  describe("API documentation", () => {
    let gen: DocumentationGenerator;

    beforeEach(() => {
      gen = new DocumentationGenerator();
    });

    it("registers API doc", () => {
      const doc = makeAPIDoc("/api/plugins");
      gen.registerAPIDoc(doc);
      assert.equal(gen.getAPIDoc("/api/plugins"), doc);
    });

    it("returns null for unknown endpoint", () => {
      const doc = gen.getAPIDoc("/api/unknown");
      assert.equal(doc, null);
    });

    it("gets all API docs", () => {
      gen.registerAPIDoc(makeAPIDoc("/api/plugins"));
      gen.registerAPIDoc(makeAPIDoc("/api/authors"));
      const all = gen.getAllAPIDocsIndex();
      assert.equal(all.length, 2);
    });

    it("generates OpenAPI spec", () => {
      gen.registerAPIDoc(makeAPIDoc("/api/plugins", { method: "GET" }));
      const spec = gen.generateOpenAPISpec("3.0.0");
      assert.equal(spec.openapi, "3.0.0");
      assert(spec.paths);
    });
  });

  describe("examples", () => {
    let gen: DocumentationGenerator;

    beforeEach(() => {
      gen = new DocumentationGenerator();
    });

    it("registers an example", () => {
      const example = makeExample("ex-1");
      gen.registerExample(example);
      assert.equal(gen.getExample("ex-1"), example);
    });

    it("gets examples by tag", () => {
      gen.registerExample(makeExample("ex-1", { tags: ["api"] }));
      gen.registerExample(makeExample("ex-2", { tags: ["api", "auth"] }));
      gen.registerExample(makeExample("ex-3", { tags: ["database"] }));

      const apiExamples = gen.getExamplesByTag("api");
      assert.equal(apiExamples.length, 2);
    });

    it("gets examples by difficulty", () => {
      gen.registerExample(makeExample("ex-1", { difficulty: "beginner" }));
      gen.registerExample(makeExample("ex-2", { difficulty: "advanced" }));

      const beginner = gen.getExamplesByDifficulty("beginner");
      assert.equal(beginner.length, 1);
    });
  });

  describe("tutorials", () => {
    let gen: DocumentationGenerator;

    beforeEach(() => {
      gen = new DocumentationGenerator();
    });

    it("registers a tutorial", () => {
      const tutorial = makeTutorial("tut-1");
      gen.registerTutorial(tutorial);
      assert.equal(gen.getTutorial("tut-1"), tutorial);
    });

    it("gets tutorials by difficulty", () => {
      gen.registerTutorial(makeTutorial("tut-1", { difficulty: "beginner" }));
      gen.registerTutorial(makeTutorial("tut-2", { difficulty: "advanced" }));

      const beginner = gen.getTutorialsByDifficulty("beginner");
      assert.equal(beginner.length, 1);
    });

    it("gets beginner tutorials", () => {
      gen.registerTutorial(makeTutorial("tut-1", { difficulty: "beginner" }));
      gen.registerTutorial(makeTutorial("tut-2", { difficulty: "advanced" }));

      const beginner = gen.getBeginnerTutorials();
      assert.equal(beginner.length, 1);
    });
  });

  describe("collections", () => {
    let gen: DocumentationGenerator;

    beforeEach(() => {
      gen = new DocumentationGenerator();
    });

    it("creates a collection", () => {
      const page = gen.createPage("Test", "Content", "guide", "author-1");
      const col = gen.createCollection("Getting Started", "Getting started docs", [page], 1);
      assert.equal(col.category, "Getting Started");
    });

    it("gets collection by category", () => {
      const page = gen.createPage("Test", "Content", "guide", "author-1");
      gen.createCollection("API", "API docs", [page], 1);
      const col = gen.getCollection("API");
      assert(col);
      assert.equal(col.category, "API");
    });

    it("gets all collections sorted by order", () => {
      const p1 = gen.createPage("Page 1", "Content", "guide", "author-1");
      const p2 = gen.createPage("Page 2", "Content", "guide", "author-1");
      gen.createCollection("Z Category", "Docs", [p1], 3);
      gen.createCollection("A Category", "Docs", [p2], 1);

      const cols = gen.getAllCollections();
      assert.equal(cols[0].category, "A Category");
      assert.equal(cols[1].category, "Z Category");
    });
  });

  describe("export & generation", () => {
    let gen: DocumentationGenerator;

    beforeEach(() => {
      gen = new DocumentationGenerator();
      const p1 = gen.createPage("Guide 1", "# Content", "guide", "author-1");
      const p2 = gen.createPage("API Reference", "# API", "api", "author-1");
      gen.createCollection("Guides", "Guide docs", [p1], 1);
      gen.createCollection("API", "API docs", [p2], 2);
    });

    it("generates site structure", () => {
      const structure = gen.generateSiteStructure();
      assert(structure.collections);
      assert(structure.collections.length > 0);
    });

    it("generates markdown dump", () => {
      const dump = gen.generateMarkdownDump();
      assert(Object.keys(dump).length > 0);
      assert(Object.keys(dump).some((k) => k.includes(".md")));
    });

    it("generates navigation", () => {
      const nav = gen.generateNavigation();
      assert(nav.length > 0);
      assert(nav[0].items.length > 0);
    });
  });

  describe("statistics", () => {
    let gen: DocumentationGenerator;

    beforeEach(() => {
      gen = new DocumentationGenerator();
    });

    it("returns documentation statistics", () => {
      gen.createPage("Page 1", "Content", "guide", "author-1");
      gen.createPage("Page 2", "Content", "api", "author-1");
      gen.registerExample(makeExample("ex-1"));
      gen.registerTutorial(makeTutorial("tut-1"));

      const stats = gen.getStats();
      assert.equal(stats.totalPages, 2);
      assert.equal(stats.totalExamples, 1);
      assert.equal(stats.totalTutorials, 1);
    });

    it("counts pages by type", () => {
      gen.createPage("Guide", "Content", "guide", "author-1");
      gen.createPage("API", "Content", "api", "author-1");
      gen.createPage("Tutorial", "Content", "tutorial", "author-1");

      const stats = gen.getStats();
      assert.equal(stats.byType.guide, 1);
      assert.equal(stats.byType.api, 1);
      assert.equal(stats.byType.tutorial, 1);
    });

    it("calculates average page length", () => {
      gen.createPage("Short", "Hi", "guide", "author-1");
      gen.createPage("Long", "This is a longer content string", "guide", "author-1");

      const stats = gen.getStats();
      assert(stats.avgPageLength > 0);
    });

    it("tracks total views", () => {
      const p1 = gen.createPage("Page", "Content", "guide", "author-1");
      gen.getPage(p1.id);
      gen.getPage(p1.id);

      const stats = gen.getStats();
      assert.equal(stats.totalViews, 2);
    });
  });
});

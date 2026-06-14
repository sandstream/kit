import { IdGenerators } from "./id-generator.js";
// ─── Types ────────────────────────────────────────────────────────────────────

export type DocType = "guide" | "api" | "example" | "tutorial" | "troubleshooting" | "architecture";
export type DocFormat = "markdown" | "html" | "pdf";

export interface DocPage {
  id: string;
  title: string;
  slug: string;
  type: DocType;
  content: string;
  format: DocFormat;
  author: string;
  createdAt: string;
  updatedAt: string;
  views: number;
  tags: string[];
  relatedPages: string[];
  toc?: TableOfContents[];
}

export interface TableOfContents {
  level: number;
  title: string;
  id: string;
}

export interface APIDoc {
  endpoint: string;
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  response: {
    type: string;
    example: Record<string, unknown>;
  };
  errors: Array<{
    code: number;
    message: string;
  }>;
}

export interface Example {
  id: string;
  title: string;
  description: string;
  language: "typescript" | "javascript" | "python" | "bash";
  code: string;
  explanation: string;
  tags: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  runnable: boolean;
}

export interface Tutorial {
  id: string;
  title: string;
  description: string;
  steps: Array<{
    title: string;
    content: string;
    code?: string;
    expectedOutcome: string;
  }>;
  estimatedTime: number; // minutes
  difficulty: "beginner" | "intermediate" | "advanced";
  prerequisites: string[];
  relatedDocs: string[];
}

export interface DocSearchResult {
  page: DocPage;
  relevance: number;
  snippet: string;
}

export interface DocCollection {
  category: string;
  pages: DocPage[];
  description: string;
  order: number;
}

// ─── DocumentationGenerator ───────────────────────────────────────────────────

export class DocumentationGenerator {
  private pages: Map<string, DocPage> = new Map();
  private apiDocs: Map<string, APIDoc> = new Map();
  private examples: Map<string, Example> = new Map();
  private tutorials: Map<string, Tutorial> = new Map();
  private collections: Map<string, DocCollection> = new Map();
  private searchIndex: Map<string, Set<string>> = new Map(); // term → pageIds

  // ─── Page Management ──────────────────────────────────────────────────────

  /**
   * Create a documentation page.
   */
  createPage(
    title: string,
    content: string,
    type: DocType,
    author: string,
    tags: string[] = [],
  ): DocPage {
    const id = IdGenerators.documentation();
    const slug = title.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "");

    const page: DocPage = {
      id,
      title,
      slug,
      type,
      content,
      format: "markdown",
      author,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      views: 0,
      tags,
      relatedPages: [],
      toc: this.generateTableOfContents(content),
    };

    this.pages.set(id, page);
    this.indexPage(id, content);
    return page;
  }

  /**
   * Get a page by ID.
   */
  getPage(pageId: string): DocPage | null {
    const page = this.pages.get(pageId);
    if (page) {
      page.views++;
    }
    return page || null;
  }

  /**
   * Update a page.
   */
  updatePage(pageId: string, updates: Partial<DocPage>): DocPage | null {
    const page = this.pages.get(pageId);
    if (!page) return null;

    Object.assign(page, updates, { updatedAt: new Date().toISOString() });
    return page;
  }

  /**
   * Delete a page.
   */
  deletePage(pageId: string): boolean {
    const page = this.pages.get(pageId);
    if (!page) return false;

    // Remove from index
    const terms = this.extractTerms(page.content);
    for (const term of terms) {
      this.searchIndex.get(term)?.delete(pageId);
    }

    this.pages.delete(pageId);
    return true;
  }

  // ─── Table of Contents ────────────────────────────────────────────────────

  /**
   * Generate table of contents from markdown headings.
   */
  private generateTableOfContents(content: string): TableOfContents[] {
    const headings: TableOfContents[] = [];
    const lines = content.split("\n");

    lines.forEach((line) => {
      const match = line.match(/^(#+)\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        const title = match[2];
        const id = title.toLowerCase().replace(/\s+/g, "-");

        headings.push({ level, title, id });
      }
    });

    return headings;
  }

  // ─── Search & Indexing ───────────────────────────────────────────────────

  /**
   * Index page content for full-text search.
   */
  private indexPage(pageId: string, content: string): void {
    const terms = this.extractTerms(content);
    for (const term of terms) {
      const pages = this.searchIndex.get(term) || new Set();
      pages.add(pageId);
      this.searchIndex.set(term, pages);
    }
  }

  /**
   * Extract searchable terms from content.
   */
  private extractTerms(content: string): string[] {
    return content
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length > 2 && !this.isStopWord(term));
  }

  private isStopWord(word: string): boolean {
    const stops = ["the", "and", "or", "is", "are", "was", "be", "to", "of", "in", "on", "at"];
    return stops.includes(word);
  }

  /**
   * Search documentation by keyword.
   */
  search(query: string, limit = 20): DocSearchResult[] {
    const terms = this.extractTerms(query);
    const pageScores = new Map<string, number>();

    for (const term of terms) {
      const pageIds = this.searchIndex.get(term) || new Set();
      for (const pageId of pageIds) {
        pageScores.set(pageId, (pageScores.get(pageId) || 0) + 1);
      }
    }

    return [...pageScores.entries()]
      .map(([pageId, score]) => {
        const page = this.pages.get(pageId)!;
        const snippet = this.extractSnippet(page.content, query, 150);
        return { page, relevance: score, snippet };
      })
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  /**
   * Extract snippet around query term.
   */
  private extractSnippet(content: string, query: string, length: number): string {
    const index = content.toLowerCase().indexOf(query.toLowerCase());
    if (index === -1) return content.substring(0, length) + "...";

    const start = Math.max(0, index - length / 2);
    const end = Math.min(content.length, start + length);
    return (start > 0 ? "..." : "") + content.substring(start, end) + (end < content.length ? "..." : "");
  }

  // ─── API Documentation ───────────────────────────────────────────────────

  /**
   * Register API endpoint documentation.
   */
  registerAPIDoc(doc: APIDoc): void {
    this.apiDocs.set(doc.endpoint, doc);
  }

  /**
   * Get API documentation for an endpoint.
   */
  getAPIDoc(endpoint: string): APIDoc | null {
    return this.apiDocs.get(endpoint) || null;
  }

  /**
   * Get all API documentation.
   */
  getAllAPIDocsIndex(): APIDoc[] {
    return [...this.apiDocs.values()];
  }

  /**
   * Generate OpenAPI spec from registered endpoints.
   */
  generateOpenAPISpec(version: string = "3.0.0", baseUrl: string = "https://github.com/sandstream/kit"): Record<string, unknown> {
    const paths: Record<string, unknown> = {};

    for (const doc of this.apiDocs.values()) {
      paths[doc.endpoint] = {
        [doc.method.toLowerCase()]: {
          summary: doc.description,
          parameters: doc.parameters,
          responses: {
            200: {
              description: "Success",
              content: {
                "application/json": {
                  schema: doc.response,
                },
              },
            },
            ...Object.fromEntries(doc.errors.map((e) => [e.code, { description: e.message }])),
          },
        },
      };
    }

    return {
      openapi: version,
      info: { title: "kit Marketplace API", version },
      servers: [{ url: baseUrl }],
      paths,
    };
  }

  // ─── Examples ────────────────────────────────────────────────────────────

  /**
   * Register a code example.
   */
  registerExample(example: Example): void {
    this.examples.set(example.id, example);
  }

  /**
   * Get example by ID.
   */
  getExample(exampleId: string): Example | null {
    return this.examples.get(exampleId) || null;
  }

  /**
   * Get examples by tag.
   */
  getExamplesByTag(tag: string): Example[] {
    return [...this.examples.values()].filter((e) => e.tags.includes(tag));
  }

  /**
   * Get examples by difficulty.
   */
  getExamplesByDifficulty(difficulty: string): Example[] {
    return [...this.examples.values()].filter((e) => e.difficulty === difficulty);
  }

  // ─── Tutorials ───────────────────────────────────────────────────────────

  /**
   * Register a tutorial.
   */
  registerTutorial(tutorial: Tutorial): void {
    this.tutorials.set(tutorial.id, tutorial);
  }

  /**
   * Get tutorial by ID.
   */
  getTutorial(tutorialId: string): Tutorial | null {
    return this.tutorials.get(tutorialId) || null;
  }

  /**
   * Get tutorials by difficulty.
   */
  getTutorialsByDifficulty(difficulty: string): Tutorial[] {
    return [...this.tutorials.values()].filter((t) => t.difficulty === difficulty);
  }

  /**
   * Get tutorials for beginners.
   */
  getBeginnerTutorials(): Tutorial[] {
    return this.getTutorialsByDifficulty("beginner");
  }

  // ─── Collections ─────────────────────────────────────────────────────────

  /**
   * Create a documentation collection (category).
   */
  createCollection(
    category: string,
    description: string,
    pages: DocPage[],
    order: number = 0,
  ): DocCollection {
    const collection: DocCollection = {
      category,
      pages,
      description,
      order,
    };
    this.collections.set(category, collection);
    return collection;
  }

  /**
   * Get collection by category.
   */
  getCollection(category: string): DocCollection | null {
    return this.collections.get(category) || null;
  }

  /**
   * Get all collections sorted by order.
   */
  getAllCollections(): DocCollection[] {
    return [...this.collections.values()].sort((a, b) => a.order - b.order);
  }

  // ─── Export & Generation ─────────────────────────────────────────────────

  /**
   * Generate documentation HTML site structure.
   */
  generateSiteStructure(): {
    collections: Array<{
      name: string;
      pages: Array<{ title: string; slug: string; type: DocType }>;
    }>;
  } {
    return {
      collections: this.getAllCollections().map((col) => ({
        name: col.category,
        pages: col.pages.map((p) => ({
          title: p.title,
          slug: p.slug,
          type: p.type,
        })),
      })),
    };
  }

  /**
   * Generate a static site dump (markdown files).
   */
  generateMarkdownDump(): Record<string, string> {
    const dump: Record<string, string> = {};

    for (const page of this.pages.values()) {
      const filename = `${page.slug}.md`;
      dump[filename] = `# ${page.title}\n\n${page.content}`;
    }

    return dump;
  }

  /**
   * Generate navigation sidebar structure.
   */
  generateNavigation(): Array<{
    label: string;
    items: Array<{ label: string; href: string; type: DocType }>;
  }> {
    return this.getAllCollections().map((col) => ({
      label: col.category,
      items: col.pages.map((p) => ({
        label: p.title,
        href: `/docs/${p.slug}`,
        type: p.type,
      })),
    }));
  }

  // ─── Statistics ───────────────────────────────────────────────────────────

  /**
   * Get documentation statistics.
   */
  getStats(): {
    totalPages: number;
    byType: Record<DocType, number>;
    totalViews: number;
    totalExamples: number;
    totalTutorials: number;
    avgPageLength: number;
  } {
    const byType: Record<DocType, number> = {} as Record<DocType, number>;
    let totalLength = 0;
    let totalViews = 0;

    for (const page of this.pages.values()) {
      byType[page.type] = (byType[page.type] || 0) + 1;
      totalLength += page.content.length;
      totalViews += page.views;
    }

    return {
      totalPages: this.pages.size,
      byType,
      totalViews,
      totalExamples: this.examples.size,
      totalTutorials: this.tutorials.size,
      avgPageLength: this.pages.size > 0 ? Math.round(totalLength / this.pages.size) : 0,
    };
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getPagesCache(): Map<string, DocPage> {
    return this.pages;
  }

  getExamplesCache(): Map<string, Example> {
    return this.examples;
  }

  getTutorialsCache(): Map<string, Tutorial> {
    return this.tutorials;
  }

  getAPIDocsCache(): Map<string, APIDoc> {
    return this.apiDocs;
  }
}

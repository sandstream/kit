import type * as TypeScript from "typescript";
import type {
  BodyMetric,
  Compiler,
  WorkerFile,
  WorkerInput,
} from "./standards-javascript-worker-protocol.js";
import {
  bodyName,
  decisionOffset,
  functionNode,
  isErased,
  sourceKind,
} from "./standards-javascript-worker-syntax.js";

/** Version-pinned parser evidence; TypeScript does not declare this field publicly. */
type ParsedSource = TypeScript.SourceFile & {
  parseDiagnostics: readonly TypeScript.DiagnosticWithLocation[];
};

class BodyCollector {
  readonly bodies: BodyMetric[] = [];

  constructor(
    private readonly api: Compiler,
    private readonly source: TypeScript.SourceFile,
  ) {}

  private add(node: TypeScript.Node, kind: BodyMetric["kind"], name: string): BodyMetric {
    const start = kind === "module" ? 0 : node.getStart(this.source);
    const end = node.getEnd();
    const first = this.source.getLineAndCharacterOfPosition(start).line;
    const last = this.source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line;
    const body: BodyMetric = {
      id: `${kind}:${start}`,
      name,
      kind,
      start,
      end,
      ccn: 1,
      length: last - first + 1,
      decisions: [],
    };
    this.bodies.push(body);
    return body;
  }

  private decision(node: TypeScript.Node, owner: BodyMetric): void {
    const offset = decisionOffset(this.api, node);
    if (offset !== undefined) owner.decisions.push(offset);
  }

  private decorators(node: TypeScript.Node, owner: BodyMetric): void {
    if (!this.api.canHaveDecorators(node)) return;
    for (const decorator of this.api.getDecorators(node) ?? [])
      this.visit(decorator.expression, owner);
  }

  private computedName(node: TypeScript.NamedDeclaration, owner: BodyMetric): void {
    if (node.name && this.api.isComputedPropertyName(node.name))
      this.visit(node.name.expression, owner);
  }

  private function(node: TypeScript.FunctionLikeDeclaration, owner: BodyMetric): void {
    if (!node.body) return;
    this.decorators(node, owner);
    this.computedName(node, owner);
    const body = this.add(node, "function", bodyName(this.api, node));
    for (const parameter of node.parameters) {
      this.decorators(parameter, owner);
      this.decision(parameter, body);
      this.visit(parameter.name, body);
      if (parameter.initializer) this.visit(parameter.initializer, body);
    }
    this.visit(node.body, body);
  }

  private property(node: TypeScript.PropertyDeclaration, owner: BodyMetric): void {
    this.decorators(node, owner);
    this.computedName(node, owner);
    if (!node.initializer) return;
    const body = this.add(node.initializer, "initializer", bodyName(this.api, node));
    this.visit(node.initializer, body);
  }

  private heritage(node: TypeScript.HeritageClause, owner: BodyMetric): void {
    if (node.token !== this.api.SyntaxKind.ExtendsKeyword) return;
    if (!this.api.isClassDeclaration(node.parent) && !this.api.isClassExpression(node.parent))
      return;
    for (const type of node.types) this.visit(type.expression, owner);
  }

  private visit(node: TypeScript.Node, owner: BodyMetric): void {
    if (this.api.isHeritageClause(node)) return this.heritage(node, owner);
    if (isErased(this.api, node)) return;
    if (functionNode(this.api, node)) return this.function(node, owner);
    if (this.api.isPropertyDeclaration(node)) return this.property(node, owner);
    if (this.api.isClassStaticBlockDeclaration(node)) {
      this.visit(node.body, this.add(node, "static-block", "static block"));
      return;
    }
    this.decision(node, owner);
    // A truthy callback return would terminate the compiler's sibling traversal.
    this.api.forEachChild(node, (child) => {
      this.visit(child, owner);
    });
  }

  collect(): BodyMetric[] {
    const module = this.add(this.source, "module", "<module>");
    if (!this.source.isDeclarationFile) this.visit(this.source, module);
    for (const body of this.bodies) {
      body.decisions.sort((a, b) => a - b);
      body.ccn = 1 + body.decisions.length;
    }
    return this.bodies.sort(
      (a, b) => a.start - b.start || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    );
  }
}

export function measureFile(api: Compiler, input: WorkerInput): WorkerFile {
  const result: WorkerFile = {
    path: input.path,
    sha256: input.sha256,
    status: "invalid",
    bodies: [],
    diagnostics: [],
  };
  const kind = sourceKind(api, input.path);
  if (kind === undefined) return result;
  const source = api.createSourceFile(
    input.path,
    input.text,
    api.ScriptTarget.Latest,
    true,
    kind,
  ) as ParsedSource;
  if (!Array.isArray(source.parseDiagnostics)) throw new Error("Missing parse diagnostics");
  result.diagnostics = source.parseDiagnostics.map(({ start, length, code }) => ({
    start: start ?? 0,
    length: length ?? 0,
    code,
  }));
  if (result.diagnostics.length) return result;
  result.bodies = new BodyCollector(api, source).collect();
  result.status = "complete";
  return result;
}

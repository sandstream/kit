import ts from "typescript";

const DECLARATION_KEYS = new Set([
  "scopeNeeds",
  "egressTargets",
  "fsWrites",
  "envRequested",
  "declaredEffects",
  "infrastructure",
]);

export interface GovernanceCall {
  wrapper: string;
  operation: string | null;
  declared: boolean;
}

/** Resolve lexical constants only. Unknown or mutable inputs remain unverified. */
function contextObject(
  expression: ts.Expression,
  seen = new Set<ts.Node>(),
): ts.ObjectLiteralExpression | undefined {
  if (seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return contextObject(expression.expression, seen);
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const initializer = constantInitializer(expression);
  return initializer && contextObject(initializer, seen);
}

/** Null means a binding exists but cannot supply static evidence. */
function scopeInitializer(
  scope: ts.Block | ts.SourceFile,
  reference: ts.Identifier,
): ts.Expression | null | undefined {
  for (const statement of scope.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== reference.text) continue;
      if (
        !(statement.declarationList.flags & ts.NodeFlags.Const) ||
        declaration.pos > reference.pos
      )
        return null;
      return declaration.initializer ?? null;
    }
  }
  return undefined;
}

function constantInitializer(expression: ts.Identifier): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = expression.parent; scope; scope = scope.parent) {
    if (
      ts.isFunctionLike(scope) &&
      scope.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === expression.text,
      )
    ) {
      return undefined;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    const initializer = scopeInitializer(scope, expression);
    if (initializer !== undefined) return initializer ?? undefined;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/** Structural adoption evidence only. Runtime permission tests must prove enforcement separately. */
export function scanGovernanceCalls(source: string): GovernanceCall[] {
  const file = ts.createSourceFile("governance-source.ts", source, ts.ScriptTarget.Latest, true);
  const sites: GovernanceCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (callee === "withGovernance" || callee === "runGovernedBrokered") {
        const context = node.arguments[1] && contextObject(node.arguments[1]);
        const properties = context?.properties ?? [];
        const operation = properties.find(
          (property) => propertyName(property.name) === "operation",
        );
        sites.push({
          wrapper: callee,
          operation:
            operation &&
            ts.isPropertyAssignment(operation) &&
            ts.isStringLiteral(operation.initializer)
              ? operation.initializer.text
              : null,
          declared: properties.some((property) =>
            DECLARATION_KEYS.has(propertyName(property.name) ?? ""),
          ),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

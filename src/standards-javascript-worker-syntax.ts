import { extname } from "node:path";
import type * as TypeScript from "typescript";
import type { Compiler } from "./standards-javascript-worker-protocol.js";

export function sourceKind(api: Compiler, path: string): TypeScript.ScriptKind | undefined {
  const kinds: Record<string, TypeScript.ScriptKind> = {
    ".js": api.ScriptKind.JS,
    ".cjs": api.ScriptKind.JS,
    ".mjs": api.ScriptKind.JS,
    ".jsx": api.ScriptKind.JSX,
    ".ts": api.ScriptKind.TS,
    ".cts": api.ScriptKind.TS,
    ".mts": api.ScriptKind.TS,
    ".tsx": api.ScriptKind.TSX,
  };
  return kinds[extname(path).toLowerCase()];
}

export function functionNode(
  api: Compiler,
  node: TypeScript.Node,
): node is TypeScript.FunctionLikeDeclaration {
  return (
    api.isFunctionDeclaration(node) ||
    api.isFunctionExpression(node) ||
    api.isArrowFunction(node) ||
    api.isMethodDeclaration(node) ||
    api.isConstructorDeclaration(node) ||
    api.isGetAccessorDeclaration(node) ||
    api.isSetAccessorDeclaration(node)
  );
}

export function isErased(api: Compiler, node: TypeScript.Node): boolean {
  if (api.isInterfaceDeclaration(node) || api.isTypeAliasDeclaration(node)) return true;
  if (
    api.canHaveModifiers(node) &&
    api.getModifiers(node)?.some((m) => m.kind === api.SyntaxKind.DeclareKeyword)
  ) {
    return true;
  }
  // Instantiation expressions retain their executable expression. Their type arguments
  // remain erased when traversal reaches those children.
  return api.isTypeNode(node) && !api.isExpressionWithTypeArguments(node);
}

function patternContainer(api: Compiler, node: TypeScript.Node): TypeScript.Node | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (api.isParenthesizedExpression(parent)) return parent;
  // Type wrappers are erased, so the pattern below them is still the assignment target.
  if (
    api.isAsExpression(parent) ||
    api.isSatisfiesExpression(parent) ||
    api.isNonNullExpression(parent) ||
    api.isTypeAssertionExpression(parent)
  ) {
    return parent.expression === node ? parent : undefined;
  }
  if (api.isArrayLiteralExpression(parent) || api.isObjectLiteralExpression(parent)) return parent;
  if (api.isPropertyAssignment(parent) && parent.initializer === node) return parent;
  return undefined;
}

/** An assignment inside an expression is not a destructuring default. */
function inAssignmentPattern(api: Compiler, node: TypeScript.Node): boolean {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (!parent) return false;
    if (
      api.isBinaryExpression(parent) &&
      parent.operatorToken.kind === api.SyntaxKind.EqualsToken
    ) {
      return parent.left === current;
    }
    if (api.isForOfStatement(parent) || api.isForInStatement(parent)) {
      return parent.initializer === current;
    }
    const container = patternContainer(api, current);
    if (!container) return false;
    current = container;
  }
}

function defaultDecision(api: Compiler, node: TypeScript.Node): number | undefined {
  if ((api.isParameter(node) || api.isBindingElement(node)) && node.initializer) {
    return node.getStart();
  }
  const shorthand = api.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer;
  const assignment =
    api.isBinaryExpression(node) && node.operatorToken.kind === api.SyntaxKind.EqualsToken;
  if ((shorthand || assignment) && inAssignmentPattern(api, node)) return node.getStart();
  return undefined;
}

function expressionDecision(api: Compiler, node: TypeScript.Node): number | undefined {
  if (api.isConditionalExpression(node)) return node.questionToken.getStart();
  if (api.isBinaryExpression(node)) {
    const k = api.SyntaxKind;
    const operators = [
      k.AmpersandAmpersandToken,
      k.BarBarToken,
      k.QuestionQuestionToken,
      k.AmpersandAmpersandEqualsToken,
      k.BarBarEqualsToken,
      k.QuestionQuestionEqualsToken,
    ];
    if (operators.includes(node.operatorToken.kind)) return node.operatorToken.getStart();
  }
  if (
    api.isPropertyAccessExpression(node) ||
    api.isElementAccessExpression(node) ||
    api.isCallExpression(node)
  ) {
    return node.questionDotToken?.getStart();
  }
  return undefined;
}

/** Each returned offset contributes exactly one to classic syntactic CCN. */
export function decisionOffset(api: Compiler, node: TypeScript.Node): number | undefined {
  const k = api.SyntaxKind;
  const decisions = [
    k.IfStatement,
    k.ForStatement,
    k.ForInStatement,
    k.ForOfStatement,
    k.WhileStatement,
    k.DoStatement,
    k.CatchClause,
    k.CaseClause,
  ];
  if (decisions.includes(node.kind)) return node.getStart();
  return expressionDecision(api, node) ?? defaultDecision(api, node);
}

export function bodyName(api: Compiler, node: TypeScript.Node): string {
  if (api.isConstructorDeclaration(node)) return "constructor";
  const named = node as TypeScript.NamedDeclaration;
  if (named.name) {
    if (api.isComputedPropertyName(named.name)) return "[computed]";
    const prefix = api.isGetAccessorDeclaration(node)
      ? "get "
      : api.isSetAccessorDeclaration(node)
        ? "set "
        : "";
    return prefix + named.name.getText();
  }
  const parent = node.parent;
  if (
    parent &&
    (api.isVariableDeclaration(parent) ||
      api.isPropertyAssignment(parent) ||
      api.isPropertyDeclaration(parent))
  ) {
    return api.isComputedPropertyName(parent.name) ? "[computed]" : parent.name.getText();
  }
  return `(anonymous@${node.getStart()})`;
}

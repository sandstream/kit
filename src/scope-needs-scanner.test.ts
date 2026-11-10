import assert from "node:assert/strict";
import { it } from "node:test";
import { scanGovernanceCalls } from "./scope-needs-scanner.test-support.js";

function expected(declared: boolean, operation: string | null = "run") {
  return [{ wrapper: "withGovernance", operation, declared }];
}

it("recognizes a direct declaration", () => {
  assert.deepEqual(
    scanGovernanceCalls(
      'withGovernance(config, {operation: "run", scopeNeeds: {egress: hosts}}, operation);',
    ),
    expected(true),
  );
});

it("follows a local constant context and constant aliases", () => {
  assert.deepEqual(
    scanGovernanceCalls(
      'function execute() { const context = {operation: "run", egressTargets: hosts}; const alias = context; withGovernance(config, alias, operation); }',
    ),
    expected(true),
  );
});

for (const context of [
  '{operation: "run", metadata: {scopeNeeds: {}}}',
  '{operation: "run", metadata: "scopeNeeds: yes"}',
]) {
  it(`does not accept a declaration inside ${context}`, () => {
    assert.deepEqual(
      scanGovernanceCalls(`withGovernance(config, ${context}, operation);`),
      expected(false),
    );
  });
}

it("does not borrow an unrelated object from a later statement", () => {
  assert.deepEqual(
    scanGovernanceCalls(
      'withGovernance(config, unknownContext, operation); const later = {operation: "run", scopeNeeds: {}};',
    ),
    expected(false, null),
  );
});

it("does not borrow a constant hidden by a parameter", () => {
  assert.deepEqual(
    scanGovernanceCalls(
      'const context = {operation: "run", scopeNeeds: {}}; function execute(context) { withGovernance(config, context, operation); }',
    ),
    expected(false, null),
  );
});

it("does not treat a wrapper definition or quoted example as a call", () => {
  assert.deepEqual(
    scanGovernanceCalls(
      'function withGovernance(config, context, operation) { return operation(); } const example = "withGovernance(config, {scopeNeeds: {}}, operation)";',
    ),
    [],
  );
});

it("keeps unresolved context factory calls visible as undeclared", () => {
  assert.deepEqual(
    scanGovernanceCalls("withGovernance(config, makeContext(), operation);"),
    expected(false, null),
  );
});

it("does not trust a mutable context binding", () => {
  assert.deepEqual(
    scanGovernanceCalls(
      'let context = {operation: "run", scopeNeeds: {}}; context = unknown; withGovernance(config, context, operation);',
    ),
    expected(false, null),
  );
});

it("finds calls through a module namespace", () => {
  assert.deepEqual(
    scanGovernanceCalls(
      'governance.withGovernance(config, {operation: "run", scopeNeeds: {}}, operation);',
    ),
    expected(true),
  );
});

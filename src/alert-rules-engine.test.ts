import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventStream } from "./event-stream.js";
import { AlertRulesEngine } from "./alert-rules-engine.js";

describe("AlertRulesEngine", () => {
  let stream: EventStream;
  let engine: AlertRulesEngine;

  beforeEach(() => {
    stream = new EventStream(1000, 60000);
    engine = new AlertRulesEngine(stream);
  });

  describe("addRule", () => {
    it("adds alert rule", () => {
      const rule = engine.addRule({
        name: "High Error Rate",
        description: "Alert when error rate > 5%",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [
          {
            type: "notify",
            target: "alerts@example.com",
            severity: "high",
          },
        ],
      });

      assert.ok(rule.id);
      assert.equal(rule.name, "High Error Rate");
      assert.ok(rule.createdAt);
    });

    it("generates unique rule IDs", () => {
      const rule1 = engine.addRule({
        name: "Rule 1",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      const rule2 = engine.addRule({
        name: "Rule 2",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      assert.notEqual(rule1.id, rule2.id);
    });
  });

  describe("getRule", () => {
    it("retrieves rule by ID", () => {
      const added = engine.addRule({
        name: "Test Rule",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      const retrieved = engine.getRule(added.id);
      assert.equal(retrieved?.name, "Test Rule");
    });

    it("returns undefined for missing rule", () => {
      const rule = engine.getRule("nonexistent");
      assert.equal(rule, undefined);
    });
  });

  describe("evaluateRule", () => {
    it("evaluates rule against stream", () => {
      const rule = engine.addRule({
        name: "Error Rate",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 8 },
      });

      const result = engine.evaluateRule(rule);
      assert.equal(result.triggered, true);
      assert.equal(result.value, 8);
    });

    it("returns false when threshold not exceeded", () => {
      const rule = engine.addRule({
        name: "Error Rate",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 2 },
      });

      const result = engine.evaluateRule(rule);
      assert.equal(result.triggered, false);
    });

    it("skips evaluation if rule disabled", () => {
      const rule = engine.addRule({
        name: "Error Rate",
        description: "Test",
        enabled: false,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 100 },
      });

      const result = engine.evaluateRule(rule);
      assert.equal(result.triggered, false);
    });
  });

  describe("evaluateAll", () => {
    it("evaluates all rules", async () => {
      const rule = engine.addRule({
        name: "Error Rate",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 10 },
      });

      const triggered = await engine.evaluateAll();
      assert.equal(triggered.length, 1);
      assert.equal(triggered[0].ruleId, rule.id);
    });

    it("suppresses duplicate triggers", async () => {
      engine.addRule({
        name: "Error Rate",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 10 },
      });

      const triggered1 = await engine.evaluateAll();
      const triggered2 = await engine.evaluateAll();

      assert.equal(triggered1.length, 1);
      assert.equal(triggered2.length, 0); // Suppressed
    });

    it("calls trigger callback", async () => {
      let callbackCalled = false;
      engine.setTriggerCallback(async () => {
        callbackCalled = true;
      });

      engine.addRule({
        name: "Error Rate",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 10 },
      });

      await engine.evaluateAll();
      assert.ok(callbackCalled);
    });
  });

  describe("acknowledgeAlert", () => {
    it("acknowledges alert to suppress duplicates", async () => {
      const rule = engine.addRule({
        name: "Error Rate",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 10 },
      });

      await engine.evaluateAll();
      engine.acknowledgeAlert(rule.id, 60);

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 15 },
      });

      const triggered = await engine.evaluateAll();
      assert.equal(triggered.length, 0); // Suppressed due to acknowledgement
    });
  });

  describe("getActiveAlerts", () => {
    it("returns non-acknowledged alerts", async () => {
      const rule = engine.addRule({
        name: "Error Rate",
        description: "Test for author-1",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      const active = engine.getActiveAlerts("author-1");
      assert.equal(active.length, 1);

      engine.acknowledgeAlert(rule.id);
      const activeAfter = engine.getActiveAlerts("author-1");
      assert.equal(activeAfter.length, 0);
    });
  });

  describe("getHistory", () => {
    it("returns alert trigger history", async () => {
      const rule = engine.addRule({
        name: "Error Rate",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { metric: "error_rate", value: 10 },
      });

      await engine.evaluateAll();

      const history = engine.getHistory(rule.id);
      assert.equal(history.length, 1);
      assert.equal(history[0].ruleId, rule.id);
    });
  });

  describe("removeRule", () => {
    it("removes rule by ID", () => {
      const rule = engine.addRule({
        name: "Test",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      assert.ok(engine.getRule(rule.id));
      engine.removeRule(rule.id);
      assert.equal(engine.getRule(rule.id), undefined);
    });
  });

  describe("getAllRules", () => {
    it("returns all rules", () => {
      engine.addRule({
        name: "Rule 1",
        description: "Test",
        enabled: true,
        condition: {
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      engine.addRule({
        name: "Rule 2",
        description: "Test",
        enabled: true,
        condition: {
          metric: "response_time",
          operator: ">",
          threshold: 500,
          window: 300,
          aggregation: "avg",
        },
        actions: [],
      });

      const all = engine.getAllRules();
      assert.equal(all.length, 2);
    });
  });
});

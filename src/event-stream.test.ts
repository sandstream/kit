import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventStream } from "./event-stream.js";

describe("EventStream", () => {
  let stream: EventStream;

  beforeEach(() => {
    stream = new EventStream(1000, 60000);
  });

  describe("publish", () => {
    it("publishes event to stream", () => {
      const event = stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { value: 42 },
      });

      assert.ok(event.id);
      assert.equal(event.type, "metric");
      assert.equal(event.source, "apm");
      assert.ok(event.timestamp);
    });

    it("generates unique event IDs", () => {
      const event1 = stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      const event2 = stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });

      assert.notEqual(event1.id, event2.id);
    });

    it("increments queue size", () => {
      assert.equal(stream.size(), 0);
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      assert.equal(stream.size(), 1);
    });

    it("trims queue when over capacity", () => {
      const smallStream = new EventStream(10, 60000);
      for (let i = 0; i < 15; i++) {
        smallStream.publish({
          type: "metric",
          source: "apm",
          severity: "info",
          data: { index: i },
        });
      }
      assert.equal(smallStream.size(), 10);
    });
  });

  describe("subscribe", () => {
    it("subscribes to events with filter", () => {
      const sub = stream.subscribe((e) => e.type === "metric");

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      stream.publish({
        type: "error",
        source: "api",
        severity: "warning",
        data: {},
      });
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });

      const events = sub.drain();
      assert.equal(events.length, 2);
      assert.equal(events[0].type, "metric");
      assert.equal(events[1].type, "metric");
    });

    it("routes events to subscribers", () => {
      const sub1 = stream.subscribe((e) => e.severity === "critical");
      const sub2 = stream.subscribe((e) => e.severity === "warning");

      stream.publish({
        type: "error",
        source: "api",
        severity: "critical",
        data: {},
      });
      stream.publish({
        type: "error",
        source: "api",
        severity: "warning",
        data: {},
      });

      assert.equal(sub1.drain().length, 1);
      assert.equal(sub2.drain().length, 1);
    });

    it("closes subscription", () => {
      const sub = stream.subscribe();
      assert.ok(sub.id);
      sub.close();
      // After close, new events don't route
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      assert.equal(sub.drain().length, 0);
    });

    it("respects buffer size limit", () => {
      const sub = stream.subscribe(() => true, 5);

      for (let i = 0; i < 10; i++) {
        stream.publish({
          type: "metric",
          source: "apm",
          severity: "info",
          data: { index: i },
        });
      }

      const events = sub.drain();
      assert.ok(events.length <= 5);
    });
  });

  describe("query", () => {
    it("queries events within time window", async () => {
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { value: 1 },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: { value: 2 },
      });

      // Both events published within the last 50ms — query returns both.
      const recent = stream.query(50);
      assert.equal(recent.length, 2);
    });

    it("filters query results", () => {
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      stream.publish({
        type: "error",
        source: "api",
        severity: "warning",
        data: {},
      });

      const metrics = stream.query(60000, (e) => e.type === "metric");
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].type, "metric");
    });

    it("returns empty array for no matches", () => {
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });

      const alerts = stream.query(60000, (e) => e.type === "alert");
      assert.equal(alerts.length, 0);
    });
  });

  describe("size", () => {
    it("returns queue size", () => {
      assert.equal(stream.size(), 0);
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      assert.equal(stream.size(), 2);
    });
  });

  describe("drain", () => {
    it("drains queue", async () => {
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });

      const events = await stream.drain();
      assert.equal(events.length, 2);
      assert.equal(stream.size(), 0);
    });

    it("calls drain callback", async () => {
      let callbackCalled = false;
      stream.setDrainCallback(async () => {
        callbackCalled = true;
      });

      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });

      await stream.drain();
      assert.ok(callbackCalled);
    });
  });

  describe("metrics", () => {
    it("returns stream health metrics", () => {
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });

      const metrics = stream.metrics();
      assert.equal(metrics.queueSize, 1);
      assert.equal(metrics.subscriptionCount, 0);
      assert.ok(metrics.memoryEstimateBytes > 0);
    });
  });

  describe("clear", () => {
    it("clears queue and subscriptions", () => {
      stream.publish({
        type: "metric",
        source: "apm",
        severity: "info",
        data: {},
      });
      stream.subscribe();

      const metricsBeforeClear = stream.metrics();
      assert.equal(metricsBeforeClear.queueSize, 1);
      assert.equal(metricsBeforeClear.subscriptionCount, 1);

      stream.clear();

      const metricsAfterClear = stream.metrics();
      assert.equal(metricsAfterClear.queueSize, 0);
      assert.equal(metricsAfterClear.subscriptionCount, 0);
    });
  });
});

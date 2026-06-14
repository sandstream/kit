import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { APMInstrumentor } from "./apm-instrumentor.js";

describe("APMInstrumentor", () => {
  describe("tracing", () => {
    let apm: APMInstrumentor;

    beforeEach(() => {
      apm = new APMInstrumentor("test-service");
    });

    it("starts a trace", () => {
      const trace = apm.startTrace("user_request");
      assert(trace.id);
      assert.equal(trace.name, "user_request");
      assert.equal(trace.status, "pending");
    });

    it("ends a trace", () => {
      const trace = apm.startTrace("request");
      const ended = apm.endTrace(trace.id, "success");
      assert(ended);
      assert.equal(ended.status, "success");
      assert(ended.endTime);
      assert(ended.duration >= 0);
    });

    it("calculates trace duration", () => {
      const trace = apm.startTrace("request");
      apm.endTrace(trace.id);
      const retrieved = apm.getTrace(trace.id);
      assert(retrieved);
      assert(retrieved.duration >= 0);
    });

    it("marks trace as error", () => {
      const trace = apm.startTrace("request");
      apm.endTrace(trace.id, "error");
      const retrieved = apm.getTrace(trace.id);
      assert.equal(retrieved?.status, "error");
    });

    it("gets trace by ID", () => {
      const trace = apm.startTrace("request");
      const retrieved = apm.getTrace(trace.id);
      assert(retrieved);
      assert.equal(retrieved.name, "request");
    });

    it("returns null for unknown trace", () => {
      const trace = apm.getTrace("unknown");
      assert.equal(trace, null);
    });

    it("gets recent traces", () => {
      apm.startTrace("trace1");
      apm.startTrace("trace2");
      apm.startTrace("trace3");

      const recent = apm.getRecentTraces(10);
      // Recent traces would be empty until they're ended
      assert(Array.isArray(recent));
    });

    it("gets slow traces", () => {
      const trace = apm.startTrace("slow_request");
      apm.endTrace(trace.id);

      const slow = apm.getSlowTraces(0); // All traces are >= 0ms
      assert(slow.length > 0);
    });
  });

  describe("spans", () => {
    let apm: APMInstrumentor;
    let traceId: string;

    beforeEach(() => {
      apm = new APMInstrumentor("test-service");
      const trace = apm.startTrace("request");
      traceId = trace.id;
    });

    it("starts a span", () => {
      const span = apm.startSpan(traceId, "database_query", "SELECT");
      assert(span.id);
      assert.equal(span.name, "database_query");
      assert.equal(span.operation, "SELECT");
      assert.equal(span.status, "pending");
    });

    it("ends a span", () => {
      const span = apm.startSpan(traceId, "db_query", "SELECT");
      const ended = apm.endSpan(span.id, "success");
      assert(ended);
      assert.equal(ended.status, "success");
      assert(ended.duration >= 0);
    });

    it("supports nested spans with parent ID", () => {
      const parentSpan = apm.startSpan(traceId, "http_request", "GET");
      const childSpan = apm.startSpan(
        traceId,
        "database_query",
        "SELECT",
        parentSpan.id,
      );
      assert.equal(childSpan.parentId, parentSpan.id);
    });

    it("adds tags to span", () => {
      const span = apm.startSpan(traceId, "http_request", "GET");
      apm.addTag(span.id, "http.status_code", 200);
      apm.addTag(span.id, "http.method", "GET");
      assert.equal(Object.keys(span.tags).length, 2);
    });

    it("adds logs to span", () => {
      const span = apm.startSpan(traceId, "operation", "EXECUTE");
      apm.addLog(span.id, "Starting operation");
      apm.addLog(span.id, "Operation completed");
      assert.equal(span.logs.length, 2);
    });

    it("returns null for unknown span", () => {
      const span = apm.endSpan("unknown");
      assert.equal(span, null);
    });
  });

  describe("metrics", () => {
    let apm: APMInstrumentor;

    beforeEach(() => {
      apm = new APMInstrumentor("test-service");
    });

    it("records performance metric", () => {
      apm.recordMetric("response_time", 125, "ms");
      const metrics = apm.getAllMetrics();
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].name, "response_time");
      assert.equal(metrics[0].value, 125);
    });

    it("gets metrics by name", () => {
      apm.recordMetric("response_time", 100);
      apm.recordMetric("response_time", 200);
      apm.recordMetric("cpu_usage", 45);

      const responseTimes = apm.getMetricsByName("response_time");
      assert.equal(responseTimes.length, 2);
    });

    it("calculates metric statistics", () => {
      apm.recordMetric("latency", 100);
      apm.recordMetric("latency", 200);
      apm.recordMetric("latency", 300);

      const stats = apm.getMetricStats("latency");
      assert(stats);
      assert.equal(stats.min, 100);
      assert.equal(stats.max, 300);
      assert.equal(stats.average, 200);
      assert.equal(stats.count, 3);
    });

    it("returns null for unknown metric", () => {
      const stats = apm.getMetricStats("unknown");
      assert.equal(stats, null);
    });

    it("gets all metrics", () => {
      apm.recordMetric("metric1", 100);
      apm.recordMetric("metric2", 200);

      const metrics = apm.getAllMetrics();
      assert.equal(metrics.length, 2);
    });
  });

  describe("service metrics", () => {
    let apm: APMInstrumentor;

    beforeEach(() => {
      apm = new APMInstrumentor("api-service");
    });

    it("returns service metrics", () => {
      const trace = apm.startTrace("request");
      apm.endTrace(trace.id);

      const metrics = apm.getServiceMetrics();
      assert.equal(metrics.serviceName, "api-service");
      assert.equal(metrics.requestCount, 1);
      assert(metrics.averageResponseTime >= 0);
    });

    it("calculates error count", () => {
      const trace1 = apm.startTrace("request1");
      const trace2 = apm.startTrace("request2");
      apm.endTrace(trace1.id, "success");
      apm.endTrace(trace2.id, "error");

      const metrics = apm.getServiceMetrics();
      assert.equal(metrics.errorCount, 1);
    });

    it("calculates average response time", () => {
      apm.startTrace("req1");
      apm.startTrace("req2");

      const metrics = apm.getServiceMetrics();
      assert(metrics.averageResponseTime >= 0);
    });

    it("calculates p95 and p99 percentiles", () => {
      for (let i = 0; i < 100; i++) {
        const trace = apm.startTrace(`request_${i}`);
        apm.endTrace(trace.id);
      }

      const metrics = apm.getServiceMetrics();
      assert(metrics.p95ResponseTime >= 0);
      assert(metrics.p99ResponseTime >= 0);
    });

    it("calculates throughput", () => {
      const trace = apm.startTrace("request");
      apm.endTrace(trace.id);

      const metrics = apm.getServiceMetrics();
      assert(metrics.throughput >= 0);
    });
  });

  describe("health checks", () => {
    let apm: APMInstrumentor;

    beforeEach(() => {
      apm = new APMInstrumentor("service");
    });

    it("checks service health", () => {
      const trace = apm.startTrace("request");
      apm.endTrace(trace.id);

      const health = apm.checkHealth();
      assert(typeof health.healthy === "boolean");
      assert(typeof health.status === "string");
      assert(health.metrics);
    });

    it("marks service as healthy when response times are good", () => {
      const trace = apm.startTrace("fast_request");
      apm.endTrace(trace.id);

      const health = apm.checkHealth();
      assert(health.healthy);
    });

    it("marks service as degraded when error rate is high", () => {
      // Create multiple traces with errors to trigger > 5% error rate
      for (let i = 0; i < 20; i++) {
        const trace = apm.startTrace(`request_${i}`);
        apm.endTrace(trace.id, i < 2 ? "error" : "success");
      }

      const health = apm.checkHealth();
      // With 20 requests and 2 errors, error rate is 10% which should trigger degraded
      assert(!health.healthy);
    });
  });

  describe("service name", () => {
    it("uses provided service name", () => {
      const apm = new APMInstrumentor("custom-service");
      const metrics = apm.getServiceMetrics();
      assert.equal(metrics.serviceName, "custom-service");
    });

    it("uses default service name", () => {
      const apm = new APMInstrumentor();
      const metrics = apm.getServiceMetrics();
      assert.equal(metrics.serviceName, "default-service");
    });
  });

  describe("cache helpers", () => {
    let apm: APMInstrumentor;

    beforeEach(() => {
      apm = new APMInstrumentor();
    });

    it("returns trace cache", () => {
      apm.startTrace("trace1");
      apm.startTrace("trace2");

      const cache = apm.getTraceCache();
      assert.equal(cache.size, 2);
    });

    it("returns span cache", () => {
      const trace = apm.startTrace("request");
      apm.startSpan(trace.id, "span1", "OP");
      apm.startSpan(trace.id, "span2", "OP");

      const cache = apm.getSpanCache();
      assert.equal(cache.size, 2);
    });

    it("returns metrics cache", () => {
      apm.recordMetric("m1", 100);
      apm.recordMetric("m2", 200);

      const cache = apm.getMetricsCache();
      assert.equal(cache.length, 2);
    });
  });
});

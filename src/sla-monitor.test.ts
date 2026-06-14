import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SLAMonitor } from "./sla-monitor.js";

describe("SLAMonitor", () => {
  describe("SLA management", () => {
    let monitor: SLAMonitor;

    beforeEach(() => {
      monitor = new SLAMonitor();
    });

    it("creates an SLA", () => {
      const sla = monitor.createSLA(
        "API Availability",
        "availability",
        99.9,
        99.0,
        "%",
        "monthly",
      );
      assert(sla.id);
      assert.equal(sla.name, "API Availability");
      assert.equal(sla.target, 99.9);
    });

    it("gets SLA by ID", () => {
      const sla = monitor.createSLA(
        "API Latency",
        "latency",
        200,
        300,
        "ms",
        "daily",
      );
      const retrieved = monitor.getSLA(sla.id);
      assert(retrieved);
      assert.equal(retrieved.name, "API Latency");
    });

    it("returns null for unknown SLA", () => {
      const sla = monitor.getSLA("unknown");
      assert.equal(sla, null);
    });

    it("gets all SLAs", () => {
      monitor.createSLA("SLA 1", "availability", 99.9, 99.0, "%", "monthly");
      monitor.createSLA("SLA 2", "latency", 200, 300, "ms", "daily");
      const all = monitor.getAllSLAs();
      assert.equal(all.length, 2);
    });

    it("updates SLA target", () => {
      const sla = monitor.createSLA("Test", "availability", 99.9, 99.0, "%", "monthly");
      const updated = monitor.updateSLATarget(sla.id, 99.95);
      assert(updated);
      assert.equal(updated.target, 99.95);
    });

    it("deletes SLA", () => {
      const sla = monitor.createSLA("Test", "availability", 99.9, 99.0, "%", "monthly");
      const deleted = monitor.deleteSLA(sla.id);
      assert(deleted);
      assert.equal(monitor.getSLA(sla.id), null);
    });
  });

  describe("measurements", () => {
    let monitor: SLAMonitor;
    let slaId: string;

    beforeEach(() => {
      monitor = new SLAMonitor();
      const sla = monitor.createSLA(
        "Test SLA",
        "latency",
        100,
        200,
        "ms",
        "daily",
      );
      slaId = sla.id;
    });

    it("records measurement", () => {
      monitor.recordMeasurement(slaId, 150);
      const measurements = monitor.getMeasurements(slaId);
      assert.equal(measurements.length, 1);
      assert.equal(measurements[0].value, 150);
    });

    it("records multiple measurements", () => {
      monitor.recordMeasurement(slaId, 100);
      monitor.recordMeasurement(slaId, 150);
      monitor.recordMeasurement(slaId, 200);
      const measurements = monitor.getMeasurements(slaId);
      assert.equal(measurements.length, 3);
    });

    it("gets recent measurements with limit", () => {
      for (let i = 0; i < 20; i++) {
        monitor.recordMeasurement(slaId, 100 + i);
      }
      const recent = monitor.getMeasurements(slaId, 5);
      assert.equal(recent.length, 5);
    });
  });

  describe("breach detection", () => {
    let monitor: SLAMonitor;

    beforeEach(() => {
      monitor = new SLAMonitor();
    });

    it("detects latency breach (value above threshold)", () => {
      const sla = monitor.createSLA("Latency", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla.id, 300); // Above threshold
      const breaches = monitor.getBreaches(sla.id);
      assert(breaches.length > 0);
    });

    it("detects availability breach (value below threshold)", () => {
      const sla = monitor.createSLA(
        "Availability",
        "availability",
        99.9,
        99.0,
        "%",
        "monthly",
      );
      monitor.recordMeasurement(sla.id, 98.5); // Below threshold
      const breaches = monitor.getBreaches(sla.id);
      assert(breaches.length > 0);
    });

    it("doesn't record breach when within threshold", () => {
      const sla = monitor.createSLA("Latency", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla.id, 150); // Within threshold
      const breaches = monitor.getBreaches(sla.id);
      assert.equal(breaches.length, 0);
    });

    it("marks breach as critical for large deviations", () => {
      const sla = monitor.createSLA("Latency", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla.id, 500); // Large deviation
      const breaches = monitor.getBreaches(sla.id);
      assert(breaches.length > 0);
      // Check severity based on deviation
      assert(breaches[0].severity);
    });

    it("gets unresolved breaches for SLA", () => {
      const sla = monitor.createSLA("Latency", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla.id, 300);
      monitor.recordMeasurement(sla.id, 350);

      const unresolved = monitor.getBreaches(sla.id, true);
      assert(unresolved.length > 0);
    });

    it("resolves a breach", () => {
      const sla = monitor.createSLA("Latency", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla.id, 300);
      const breaches = monitor.getBreaches(sla.id);
      const resolved = monitor.resolveBreach(breaches[0].id);
      assert(resolved);
      assert(resolved.resolved);
      assert(resolved.resolvedAt);
    });

    it("gets all unresolved breaches", () => {
      const sla1 = monitor.createSLA("SLA 1", "latency", 100, 200, "ms", "daily");
      const sla2 = monitor.createSLA("SLA 2", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla1.id, 300);
      monitor.recordMeasurement(sla2.id, 300);

      const unresolved = monitor.getUnresolvedBreaches();
      assert(unresolved.length >= 2);
    });
  });

  describe("status reporting", () => {
    let monitor: SLAMonitor;
    let slaId: string;

    beforeEach(() => {
      monitor = new SLAMonitor();
      const sla = monitor.createSLA("API Latency", "latency", 100, 200, "ms", "daily");
      slaId = sla.id;
      monitor.recordMeasurement(slaId, 150);
    });

    it("gets SLA status", () => {
      const status = monitor.getSLAStatus(slaId);
      assert(status);
      assert.equal(status.name, "API Latency");
      assert(status.currentValue > 0);
    });

    it("calculates percentage of target", () => {
      const status = monitor.getSLAStatus(slaId);
      assert(status);
      assert(status.percentageOfTarget >= 0);
    });

    it("determines if SLA is met", () => {
      const status = monitor.getSLAStatus(slaId);
      assert(typeof status?.isMet === "boolean");
    });

    it("counts breaches", () => {
      monitor.recordMeasurement(slaId, 300);
      const status = monitor.getSLAStatus(slaId);
      assert(status);
      assert(status.breachCount > 0);
    });

    it("gets status for all SLAs", () => {
      monitor.createSLA("SLA 2", "availability", 99.9, 99.0, "%", "monthly");
      const statuses = monitor.getAllSLAStatus();
      assert(statuses.length > 0);
    });

    it("calculates SLI (Service Level Indicator)", () => {
      monitor.recordMeasurement(slaId, 150);
      monitor.recordMeasurement(slaId, 180);
      monitor.recordMeasurement(slaId, 200);
      const sli = monitor.calculateSLI(slaId);
      assert(sli >= 0);
      assert(sli <= 100);
    });

    it("generates SLA report", () => {
      monitor.recordMeasurement(slaId, 150);
      const report = monitor.generateReport();
      assert(report.totalSLAs > 0);
      assert(typeof report.metSLAs === "number");
      assert(typeof report.sliAverage === "number");
    });
  });

  describe("metrics by type", () => {
    let monitor: SLAMonitor;

    beforeEach(() => {
      monitor = new SLAMonitor();
    });

    it("tracks availability SLA", () => {
      const sla = monitor.createSLA(
        "Uptime",
        "availability",
        99.9,
        99.0,
        "%",
        "monthly",
      );
      monitor.recordMeasurement(sla.id, 99.5);
      const status = monitor.getSLAStatus(sla.id);
      assert(status);
      assert(status.currentValue > 0);
    });

    it("tracks latency SLA", () => {
      const sla = monitor.createSLA("Response Time", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla.id, 150);
      const status = monitor.getSLAStatus(sla.id);
      assert(status?.isMet);
    });

    it("tracks error rate SLA", () => {
      const sla = monitor.createSLA(
        "Error Rate",
        "error_rate",
        0.1,
        1.0,
        "%",
        "daily",
      );
      monitor.recordMeasurement(sla.id, 0.5);
      const status = monitor.getSLAStatus(sla.id);
      assert(status?.isMet);
    });

    it("tracks throughput SLA", () => {
      const sla = monitor.createSLA(
        "Throughput",
        "throughput",
        1000,
        500,
        "req/s",
        "daily",
      );
      monitor.recordMeasurement(sla.id, 900);
      const status = monitor.getSLAStatus(sla.id);
      assert(status?.isMet);
    });
  });

  describe("cache helpers", () => {
    let monitor: SLAMonitor;

    beforeEach(() => {
      monitor = new SLAMonitor();
    });

    it("returns SLA cache", () => {
      monitor.createSLA("SLA 1", "availability", 99.9, 99.0, "%", "monthly");
      const cache = monitor.getSLACache();
      assert.equal(cache.size, 1);
    });

    it("returns breach cache", () => {
      const sla = monitor.createSLA("Latency", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla.id, 300);
      const cache = monitor.getBreachCache();
      assert(cache.size > 0);
    });

    it("returns measurements cache", () => {
      const sla = monitor.createSLA("Test", "latency", 100, 200, "ms", "daily");
      monitor.recordMeasurement(sla.id, 150);
      monitor.recordMeasurement(sla.id, 160);
      const cache = monitor.getMeasurementsCache();
      assert(cache.length >= 2);
    });
  });
});

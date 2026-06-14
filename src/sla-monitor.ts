import { IdGenerators } from "./id-generator.js";
// ─── Types ────────────────────────────────────────────────────────────────────

export interface SLAObjective {
  id: string;
  name: string;
  metric: "availability" | "latency" | "error_rate" | "throughput";
  target: number;
  threshold: number;
  unit: string;
  window: "daily" | "weekly" | "monthly";
}

export interface SLABreach {
  id: string;
  slaId: string;
  breachTime: string;
  severity: "warning" | "critical";
  details: Record<string, unknown>;
  resolved: boolean;
  resolvedAt?: string;
}

export interface SLAStatus {
  slaId: string;
  name: string;
  currentValue: number;
  target: number;
  percentageOfTarget: number;
  isMet: boolean;
  breachCount: number;
  lastBreachTime?: string;
}

// ─── SLAMonitor ───────────────────────────────────────────────────────────────

export class SLAMonitor {
  private slas: Map<string, SLAObjective> = new Map();
  private breaches: Map<string, SLABreach> = new Map();
  private measurements: Array<{
    slaId: string;
    value: number;
    timestamp: string;
  }> = [];

  // ─── SLA Management ───────────────────────────────────────────────────────

  /**
   * Create an SLA objective.
   */
  createSLA(
    name: string,
    metric: "availability" | "latency" | "error_rate" | "throughput",
    target: number,
    threshold: number,
    unit: string,
    window: "daily" | "weekly" | "monthly",
  ): SLAObjective {
    const id = IdGenerators.sla();
    const sla: SLAObjective = {
      id,
      name,
      metric,
      target,
      threshold,
      unit,
      window,
    };

    this.slas.set(id, sla);
    return sla;
  }

  /**
   * Get SLA by ID.
   */
  getSLA(slaId: string): SLAObjective | null {
    return this.slas.get(slaId) || null;
  }

  /**
   * Get all SLAs.
   */
  getAllSLAs(): SLAObjective[] {
    return [...this.slas.values()];
  }

  /**
   * Update SLA target.
   */
  updateSLATarget(slaId: string, newTarget: number): SLAObjective | null {
    const sla = this.slas.get(slaId);
    if (!sla) return null;

    sla.target = newTarget;
    return sla;
  }

  /**
   * Delete SLA.
   */
  deleteSLA(slaId: string): boolean {
    return this.slas.delete(slaId);
  }

  // ─── Measurements ────────────────────────────────────────────────────────

  /**
   * Record measurement for SLA.
   */
  recordMeasurement(slaId: string, value: number): void {
    const sla = this.slas.get(slaId);
    if (!sla) return;

    this.measurements.push({
      slaId,
      value,
      timestamp: new Date().toISOString(),
    });

    // Check if breach
    this.checkBreach(sla, value);
  }

  /**
   * Get recent measurements for SLA.
   */
  getMeasurements(slaId: string, limit = 100): Array<{
    slaId: string;
    value: number;
    timestamp: string;
  }> {
    return this.measurements
      .filter((m) => m.slaId === slaId)
      .slice(-limit);
  }

  // ─── Breach Detection ───────────────────────────────────────────────────

  private checkBreach(sla: SLAObjective, value: number): void {
    let isBreached = false;

    switch (sla.metric) {
      case "availability":
      case "throughput":
        // These should be high - breach if below threshold
        isBreached = value < sla.threshold;
        break;
      case "latency":
      case "error_rate":
        // These should be low - breach if above threshold
        isBreached = value > sla.threshold;
        break;
    }

    if (isBreached) {
      this.recordBreach(sla, value);
    }
  }

  private recordBreach(sla: SLAObjective, value: number): void {
    const id = IdGenerators.breach();
    const severity = Math.abs(value - sla.threshold) > sla.threshold * 0.2 ? "critical" : "warning";

    const breach: SLABreach = {
      id,
      slaId: sla.id,
      breachTime: new Date().toISOString(),
      severity,
      details: {
        metric: sla.metric,
        value,
        threshold: sla.threshold,
        deviation: Math.abs(value - sla.threshold),
      },
      resolved: false,
    };

    this.breaches.set(id, breach);
  }

  /**
   * Get breaches for SLA.
   */
  getBreaches(slaId: string, unresolved = true): SLABreach[] {
    return [...this.breaches.values()].filter(
      (b) => b.slaId === slaId && (!unresolved || !b.resolved),
    );
  }

  /**
   * Resolve a breach.
   */
  resolveBreach(breachId: string): SLABreach | null {
    const breach = this.breaches.get(breachId);
    if (!breach) return null;

    breach.resolved = true;
    breach.resolvedAt = new Date().toISOString();
    return breach;
  }

  /**
   * Get all unresolved breaches.
   */
  getUnresolvedBreaches(): SLABreach[] {
    return [...this.breaches.values()].filter((b) => !b.resolved);
  }

  // ─── Status & Reporting ───────────────────────────────────────────────────

  /**
   * Get current status of SLA.
   */
  getSLAStatus(slaId: string): SLAStatus | null {
    const sla = this.slas.get(slaId);
    if (!sla) return null;

    const measurements = this.getMeasurements(slaId, 100);
    if (measurements.length === 0) {
      return {
        slaId,
        name: sla.name,
        currentValue: 0,
        target: sla.target,
        percentageOfTarget: 0,
        isMet: false,
        breachCount: this.getBreaches(slaId, false).length,
      };
    }

    const currentValue = measurements[measurements.length - 1].value;
    const isMet =
      sla.metric === "availability" || sla.metric === "throughput"
        ? currentValue >= sla.threshold
        : currentValue <= sla.threshold;

    const percentageOfTarget =
      sla.target > 0 ? Math.round((currentValue / sla.target) * 100) : 0;

    const breachCount = this.getBreaches(slaId, false).length;
    const lastBreach = this.getBreaches(slaId, false)[0];

    return {
      slaId,
      name: sla.name,
      currentValue,
      target: sla.target,
      percentageOfTarget,
      isMet,
      breachCount,
      lastBreachTime: lastBreach?.breachTime,
    };
  }

  /**
   * Get status for all SLAs.
   */
  getAllSLAStatus(): SLAStatus[] {
    return [...this.slas.keys()].reduce(
      (statuses, slaId) => {
        const status = this.getSLAStatus(slaId);
        if (status) statuses.push(status);
        return statuses;
      },
      [] as SLAStatus[],
    );
  }

  /**
   * Calculate SLI (Service Level Indicator).
   */
  calculateSLI(slaId: string): number {
    const sla = this.slas.get(slaId);
    if (!sla) return 0;

    const measurements = this.getMeasurements(slaId, 100);
    if (measurements.length === 0) return 0;

    const metCount = measurements.filter((m) => {
      if (sla.metric === "availability" || sla.metric === "throughput") {
        return m.value >= sla.threshold;
      } else {
        return m.value <= sla.threshold;
      }
    }).length;

    return Math.round((metCount / measurements.length) * 100);
  }

  /**
   * Generate SLA report.
   */
  generateReport(): {
    totalSLAs: number;
    metSLAs: number;
    breachedSLAs: number;
    sliAverage: number;
  } {
    const statuses = this.getAllSLAStatus();
    const metSLAs = statuses.filter((s) => s.isMet).length;
    const breachedSLAs = statuses.filter((s) => s.breachCount > 0).length;
    const slis = statuses.map((s) => this.calculateSLI(s.slaId));
    const sliAverage = slis.length > 0 ? Math.round(slis.reduce((a, b) => a + b) / slis.length) : 0;

    return {
      totalSLAs: this.slas.size,
      metSLAs,
      breachedSLAs,
      sliAverage,
    };
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getSLACache(): Map<string, SLAObjective> {
    return this.slas;
  }

  getBreachCache(): Map<string, SLABreach> {
    return this.breaches;
  }

  getMeasurementsCache(): Array<{ slaId: string; value: number; timestamp: string }> {
    return this.measurements;
  }
}

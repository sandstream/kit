/**
 * Alert rules engine
 * Evaluates conditions against event stream and triggers actions
 */

import { IdGenerators } from "./id-generator.js";
import { EventStream, StreamEvent } from "./event-stream.js";

export type AlertMetric =
  | "error_rate"
  | "response_time"
  | "downloads"
  | "revenue"
  | "sla_breach"
  | "payout_delay"
  | "abuse_score";
export type AlertOperator = ">" | "<" | "==" | "!=" | "anomaly";
export type AlertAggregation = "avg" | "max" | "min" | "sum" | "count";
export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertActionType = "notify" | "alert" | "escalate" | "webhook";

export interface AlertAction {
  type: AlertActionType;
  target: string; // email, slack channel, webhook URL
  severity: AlertSeverity;
}

export interface AlertCondition {
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  window: number; // seconds
  aggregation: AlertAggregation;
}

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  condition: AlertCondition;
  actions: AlertAction[];
  createdAt: string;
  updatedAt: string;
  evaluatedAt?: string;
  lastTriggered?: string;
  acknowledgedUntil?: number; // timestamp; suppress alerts until this time
}

export interface AlertTriggerEvent {
  ruleId: string;
  triggeredAt: number;
  value: number;
  threshold: number;
  window: number;
  breachEvents: StreamEvent[];
}

export class AlertRulesEngine {
  private rules: Map<string, AlertRule> = new Map();
  private history: AlertTriggerEvent[] = [];
  private stream: EventStream;
  private onTrigger?: (event: AlertTriggerEvent) => Promise<void>;
  private maxHistorySize: number = 10000;

  constructor(stream: EventStream) {
    this.stream = stream;
  }

  /**
   * Add or update alert rule
   */
  addRule(rule: Omit<AlertRule, "id" | "createdAt" | "updatedAt">): AlertRule {
    const fullRule: AlertRule = {
      ...rule,
      id: IdGenerators.alert(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.rules.set(fullRule.id, fullRule);
    return fullRule;
  }

  /**
   * Remove rule by ID
   */
  removeRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  /**
   * Get rule by ID
   */
  getRule(ruleId: string): AlertRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Get all rules
   */
  getAllRules(): AlertRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get active (non-acknowledged) rules
   */
  getActiveAlerts(authorId?: string): AlertRule[] {
    const now = Date.now();
    return Array.from(this.rules.values()).filter((rule) => {
      // Skip if acknowledged
      if (rule.acknowledgedUntil && rule.acknowledgedUntil > now) {
        return false;
      }
      // Filter by author if provided
      return !authorId || rule.description.includes(authorId);
    });
  }

  /**
   * Evaluate rule against stream events
   */
  evaluateRule(rule: AlertRule): { triggered: boolean; value: number } {
    if (!rule.enabled) {
      return { triggered: false, value: 0 };
    }

    const windowMs = rule.condition.window * 1000;
    const events = this.stream.query(windowMs, (event) =>
      this.matchesMetric(event, rule.condition.metric),
    );

    const value = this.aggregateValue(events, rule.condition);
    const triggered = this.evaluateCondition(
      value,
      rule.condition.operator,
      rule.condition.threshold,
    );

    return { triggered, value };
  }

  /**
   * Evaluate all rules and trigger actions
   */
  async evaluateAll(): Promise<AlertTriggerEvent[]> {
    const triggered: AlertTriggerEvent[] = [];

    for (const rule of this.rules.values()) {
      const { triggered: shouldTrigger, value } = this.evaluateRule(rule);

      if (shouldTrigger) {
        const windowMs = rule.condition.window * 1000;
        const breachEvents = this.stream.query(windowMs, (event) =>
          this.matchesMetric(event, rule.condition.metric),
        );

        const triggerEvent: AlertTriggerEvent = {
          ruleId: rule.id,
          triggeredAt: Date.now(),
          value,
          threshold: rule.condition.threshold,
          window: rule.condition.window,
          breachEvents,
        };

        // Check if already triggered recently (within 5 minutes)
        const recentTrigger = this.history.find(
          (h) =>
            h.ruleId === rule.id &&
            Date.now() - h.triggeredAt < 5 * 60 * 1000,
        );

        if (!recentTrigger) {
          triggered.push(triggerEvent);
          this.recordTrigger(triggerEvent);

          // Update rule
          rule.lastTriggered = new Date().toISOString();
          rule.evaluatedAt = new Date().toISOString();

          // Dispatch actions
          if (this.onTrigger) {
            await this.onTrigger(triggerEvent);
          }
        }
      }
    }

    return triggered;
  }

  /**
   * Acknowledge alert to suppress duplicates
   */
  acknowledgeAlert(ruleId: string, suppressMinutes: number = 60): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.acknowledgedUntil = Date.now() + suppressMinutes * 60 * 1000;
    }
  }

  /**
   * Get alert trigger history
   */
  getHistory(
    ruleId?: string,
    limit: number = 100,
    offset: number = 0,
  ): AlertTriggerEvent[] {
    let results = this.history;
    if (ruleId) {
      results = results.filter((h) => h.ruleId === ruleId);
    }
    return results.slice(offset, offset + limit);
  }

  /**
   * Clear history
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Set trigger callback
   */
  setTriggerCallback(callback: (event: AlertTriggerEvent) => Promise<void>): void {
    this.onTrigger = callback;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private recordTrigger(event: AlertTriggerEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }
  }

  private matchesMetric(event: StreamEvent, metric: AlertMetric): boolean {
    switch (metric) {
      case "error_rate":
        return (
          event.type === "metric" &&
          event.data.metric === "error_rate"
        );
      case "response_time":
        return (
          event.type === "metric" &&
          event.data.metric === "response_time"
        );
      case "downloads":
        return (
          event.type === "metric" &&
          event.data.metric === "downloads"
        );
      case "revenue":
        return (
          event.type === "metric" &&
          event.data.metric === "revenue"
        );
      case "sla_breach":
        return event.severity === "critical" && event.data.sla_breach === true;
      case "payout_delay":
        return (
          event.type === "alert" &&
          event.data.alertType === "payout_delay"
        );
      case "abuse_score":
        return (
          event.type === "metric" &&
          event.data.metric === "abuse_score"
        );
      default:
        return false;
    }
  }

  private aggregateValue(
    events: StreamEvent[],
    condition: AlertCondition,
  ): number {
    if (events.length === 0) return 0;

    const values = events.map((e) => e.data.value || 0);

    switch (condition.aggregation) {
      case "avg":
        return values.reduce((a, b) => a + b, 0) / values.length;
      case "max":
        return Math.max(...values);
      case "min":
        return Math.min(...values);
      case "sum":
        return values.reduce((a, b) => a + b, 0);
      case "count":
        return values.length;
      default:
        return 0;
    }
  }

  private evaluateCondition(
    value: number,
    operator: AlertOperator,
    threshold: number,
  ): boolean {
    switch (operator) {
      case ">":
        return value > threshold;
      case "<":
        return value < threshold;
      case "==":
        return value === threshold;
      case "!=":
        return value !== threshold;
      case "anomaly":
        // Simplified: value is 2+ std devs above mean
        return Math.abs(value - threshold) > threshold * 0.2;
      default:
        return false;
    }
  }
}

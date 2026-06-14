/**
 * Real-time event streaming pipeline
 * Routes APM metrics and system events to subscribers and processors
 */

import { IdGenerators } from "./id-generator.js";

export type EventType = "metric" | "error" | "transaction" | "audit" | "alert";
export type EventSource = "apm" | "analytics" | "api" | "user" | "system";
export type EventSeverity = "info" | "warning" | "critical";

export interface StreamEvent {
  id: string;
  type: EventType;
  timestamp: number;
  source: EventSource;
  pluginId?: string;
  authorId?: string;
  severity: EventSeverity;
  data: Record<string, any>;
}

interface Subscription {
  id: string;
  filter: (event: StreamEvent) => boolean;
  queue: StreamEvent[];
  maxSize: number;
}

/**
 * In-memory event stream with subscription support
 * Events drain to database periodically for long-term storage
 */
export class EventStream {
  private queue: StreamEvent[] = [];
  private subscriptions: Map<string, Subscription> = new Map();
  private maxQueueSize: number;
  private drainIntervalMs: number;
  private onDrain?: (events: StreamEvent[]) => Promise<void>;
  private drainTimer?: ReturnType<typeof setInterval>;

  constructor(maxQueueSize: number = 10000, drainIntervalMs: number = 300000) {
    this.maxQueueSize = maxQueueSize;
    this.drainIntervalMs = drainIntervalMs;
    this.startDrainTimer();
  }

  /**
   * Publish event to stream
   */
  publish(event: Omit<StreamEvent, "id" | "timestamp">): StreamEvent {
    const fullEvent: StreamEvent = {
      ...event,
      id: IdGenerators.trace(),
      timestamp: Date.now(),
    };

    this.queue.push(fullEvent);

    // Route to subscribed listeners
    for (const [, subscription] of this.subscriptions) {
      if (subscription.filter(fullEvent)) {
        subscription.queue.push(fullEvent);
        if (subscription.queue.length > subscription.maxSize) {
          subscription.queue.shift();
        }
      }
    }

    // Trim queue if over capacity
    if (this.queue.length > this.maxQueueSize) {
      this.queue = this.queue.slice(-this.maxQueueSize);
    }

    return fullEvent;
  }

  /**
   * Subscribe to filtered events
   * Returns subscription handle
   */
  subscribe(
    filter: (event: StreamEvent) => boolean = () => true,
    maxBufferSize: number = 1000,
  ): {
    id: string;
    drain: () => StreamEvent[];
    close: () => void;
  } {
    const subscriptionId = IdGenerators.trace();
    const subscription: Subscription = {
      id: subscriptionId,
      filter,
      queue: [],
      maxSize: maxBufferSize,
    };

    this.subscriptions.set(subscriptionId, subscription);

    return {
      id: subscriptionId,
      drain: () => {
        const events = subscription.queue;
        subscription.queue = [];
        return events;
      },
      close: () => {
        this.subscriptions.delete(subscriptionId);
      },
    };
  }

  /**
   * Query events within time window
   */
  query(
    windowMs: number,
    filter?: (event: StreamEvent) => boolean,
  ): StreamEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.queue.filter((event) => {
      if (event.timestamp < cutoff) return false;
      return filter ? filter(event) : true;
    });
  }

  /**
   * Get current queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Drain queue to storage (database)
   */
  async drain(): Promise<StreamEvent[]> {
    if (this.queue.length === 0) {
      return [];
    }

    const events = [...this.queue];
    this.queue = [];

    if (this.onDrain) {
      await this.onDrain(events);
    }

    return events;
  }

  /**
   * Set drain callback (e.g., save to database)
   */
  setDrainCallback(callback: (events: StreamEvent[]) => Promise<void>): void {
    this.onDrain = callback;
  }

  /**
   * Start periodic drain timer
   */
  private startDrainTimer(): void {
    this.drainTimer = setInterval(() => {
      this.drain().catch((err) =>
        console.error("EventStream drain failed:", err),
      );
    }, this.drainIntervalMs);
    // Best-effort background drain — must not keep the process alive (else
    // `node --test` never exits and the suite "hangs").
    this.drainTimer.unref();
  }

  /**
   * Stop the periodic drain timer and release the event-loop handle.
   */
  close(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
  }

  /**
   * Get metrics about stream health
   */
  metrics(): {
    queueSize: number;
    subscriptionCount: number;
    memoryEstimateBytes: number;
  } {
    return {
      queueSize: this.queue.length,
      subscriptionCount: this.subscriptions.size,
      memoryEstimateBytes: JSON.stringify(this.queue).length,
    };
  }

  /**
   * Clear all events and subscriptions
   */
  clear(): void {
    this.queue = [];
    this.subscriptions.clear();
  }
}

/**
 * Global event stream singleton
 */
let globalStream: EventStream | null = null;

export function initializeEventStream(
  maxQueueSize?: number,
  drainIntervalMs?: number,
): EventStream {
  globalStream = new EventStream(maxQueueSize, drainIntervalMs);
  return globalStream;
}

export function getEventStream(): EventStream {
  if (!globalStream) {
    globalStream = new EventStream();
  }
  return globalStream;
}

// ─── Failure simulation ─────────────────────────────────────────────────────

/**
 * Whether adapters should inject simulated transport failures. On by default so
 * error paths get exercised; set KIT_NO_FAILURE_SIM=1 (the test suite does)
 * to make adapter behavior deterministic and avoid flaky assertions.
 */
export function simulatedFailuresEnabled(): boolean {
  return process.env.KIT_NO_FAILURE_SIM !== "1";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ServiceConfig {
  enabled: boolean;
  dsn?: string;
  apiKey?: string;
  apiSecret?: string;
  endpoint?: string;
  region?: string;
  customHeaders?: Record<string, string>;
}

export interface ServiceHealth {
  status: "healthy" | "degraded" | "unhealthy";
  lastCheck: string;
  responseTime: number;
  errorCount: number;
}

export interface ServiceEvent {
  type: "error" | "metric" | "log" | "trace" | "event";
  data: Record<string, unknown>;
  timestamp: string;
  tags?: Record<string, string>;
}

// ─── Service Adapter Interface ──────────────────────────────────────────────

export interface IServiceAdapter {
  name: string;
  version: string;
  config: ServiceConfig;

  // Lifecycle
  initialize(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Health & Monitoring
  getHealth(): Promise<ServiceHealth>;
  checkConnection(): Promise<boolean>;

  // Event Handling
  send(event: ServiceEvent): Promise<boolean>;
  batch(events: ServiceEvent[]): Promise<{ sent: number; failed: number }>;

  // Configuration
  updateConfig(config: Partial<ServiceConfig>): Promise<void>;
  validate(): Promise<{ valid: boolean; errors: string[] }>;
}

// ─── Abstract Service Adapter ───────────────────────────────────────────────

export abstract class AbstractServiceAdapter implements IServiceAdapter {
  name: string;
  version: string;
  config: ServiceConfig;
  protected connected: boolean = false;
  protected healthCheckInterval: NodeJS.Timeout | null = null;
  protected eventQueue: ServiceEvent[] = [];
  protected eventStats = {
    sent: 0,
    failed: 0,
    queued: 0,
  };

  constructor(name: string, version: string, config: ServiceConfig) {
    this.name = name;
    this.version = version;
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      console.log(`${this.name} is disabled`);
      return;
    }

    await this.validate();
    await this.connect();
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  isConnected(): boolean {
    return this.connected;
  }

  abstract getHealth(): Promise<ServiceHealth>;

  async checkConnection(): Promise<boolean> {
    try {
      const health = await this.getHealth();
      return health.status !== "unhealthy";
    } catch {
      return false;
    }
  }

  async send(event: ServiceEvent): Promise<boolean> {
    if (!this.connected) {
      this.eventQueue.push(event);
      this.eventStats.queued++;
      return false;
    }

    try {
      await this.sendEvent(event);
      this.eventStats.sent++;
      return true;
    } catch {
      this.eventQueue.push(event);
      this.eventStats.failed++;
      return false;
    }
  }

  async batch(events: ServiceEvent[]): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    for (const event of events) {
      const success = await this.send(event);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    return { sent, failed };
  }

  async updateConfig(config: Partial<ServiceConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    if (this.connected) {
      await this.disconnect();
      await this.connect();
    }
  }

  async validate(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (this.config.enabled) {
      if (!this.config.dsn && !this.config.apiKey) {
        errors.push(`${this.name} requires either DSN or API Key`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  protected abstract sendEvent(event: ServiceEvent): Promise<void>;

  protected getQueuedEvents(): ServiceEvent[] {
    return [...this.eventQueue];
  }

  protected clearQueue(): void {
    this.eventQueue = [];
  }

  getStats(): typeof this.eventStats {
    return { ...this.eventStats };
  }
}

// ─── Service Registry ────────────────────────────────────────────────────────

export class ServiceRegistry {
  private adapters: Map<string, IServiceAdapter> = new Map();

  register(adapter: IServiceAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): IServiceAdapter | null {
    return this.adapters.get(name) || null;
  }

  getAll(): IServiceAdapter[] {
    return [...this.adapters.values()];
  }

  async initializeAll(): Promise<{ initialized: number; failed: number }> {
    let initialized = 0;
    let failed = 0;

    for (const adapter of this.adapters.values()) {
      try {
        await adapter.initialize();
        initialized++;
      } catch {
        failed++;
      }
    }

    return { initialized, failed };
  }

  async disconnectAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.disconnect();
      } catch {
        // Ignore errors during disconnect
      }
    }
  }

  async getHealthStatus(): Promise<Record<string, ServiceHealth>> {
    const status: Record<string, ServiceHealth> = {};

    for (const adapter of this.adapters.values()) {
      try {
        status[adapter.name] = await adapter.getHealth();
      } catch {
        status[adapter.name] = {
          status: "unhealthy",
          lastCheck: new Date().toISOString(),
          responseTime: -1,
          errorCount: 1,
        };
      }
    }

    return status;
  }
}

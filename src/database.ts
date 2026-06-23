// ─── Types ────────────────────────────────────────────────────────────────────

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  poolSize?: number;
  maxConnections?: number;
  idleTimeout?: number;
  connectionTimeout?: number;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  executionTime: number;
}

export interface Migration {
  id: string;
  name: string;
  version: string;
  sql: string;
  executedAt?: string;
  executedBy?: string;
}

export interface DatabaseHealth {
  status: "healthy" | "degraded" | "unhealthy";
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  lastHealthCheck: string;
}

// ─── Database Manager ────────────────────────────────────────────────────────

export class DatabaseManager {
  private config: DatabaseConfig;
  private pool: ConnectionPool;
  private migrations: Map<string, Migration> = new Map();
  private isInitialized: boolean = false;
  private queryLog: Array<{ sql: string; duration: number; timestamp: string }> = [];

  constructor(config: DatabaseConfig) {
    this.config = {
      poolSize: 10,
      maxConnections: 20,
      idleTimeout: 30000,
      connectionTimeout: 5000,
      ...config,
    };
    this.pool = new ConnectionPool(this.config);
  }

  // ─── Connection Management ──────────────────────────────────────────────

  /**
   * Initialize database connection pool.
   */
  async connect(): Promise<void> {
    if (this.isInitialized) return;

    try {
      await this.pool.initialize();
      this.isInitialized = true;

      // Test connection
      const result = await this.query("SELECT 1 as test");
      if (result.rowCount === 0) {
        throw new Error("Database connection test failed");
      }
    } catch (error) {
      throw new Error(`Failed to connect to database: ${error}`);
    }
  }

  /**
   * Close all connections.
   */
  async disconnect(): Promise<void> {
    if (!this.isInitialized) return;
    await this.pool.drain();
    this.isInitialized = false;
  }

  /**
   * Check if database is connected.
   */
  isConnected(): boolean {
    return this.isInitialized;
  }

  // ─── Query Execution ──────────────────────────────────────────────────

  /**
   * Execute a query.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (!this.isInitialized) {
      throw new Error("Database not initialized");
    }

    const startTime = Date.now();

    try {
      const connection = await this.pool.getConnection();
      const result = await connection.query(sql, params);
      this.pool.releaseConnection(connection);

      const executionTime = Date.now() - startTime;
      this.logQuery(sql, executionTime);

      return {
        rows: result.rows as T[],
        rowCount: result.rowCount,
        executionTime,
      };
    } catch (error) {
      throw new Error(`Query failed: ${error}`);
    }
  }

  /**
   * Execute a query with transaction.
   */
  async transaction<T>(callback: (db: DatabaseManager) => Promise<T>): Promise<T> {
    if (!this.isInitialized) {
      throw new Error("Database not initialized");
    }

    const connection = await this.pool.getConnection();

    try {
      await connection.query("BEGIN");
      const result = await callback(this);
      await connection.query("COMMIT");
      this.pool.releaseConnection(connection);
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      this.pool.releaseConnection(connection);
      throw new Error(`Transaction failed: ${error}`);
    }
  }

  /**
   * Execute multiple queries in batch.
   */
  async batch(queries: Array<{ sql: string; params: unknown[] }>): Promise<QueryResult[]> {
    if (!this.isInitialized) {
      throw new Error("Database not initialized");
    }

    const results: QueryResult[] = [];

    for (const { sql, params } of queries) {
      const result = await this.query(sql, params);
      results.push(result);
    }

    return results;
  }

  // ─── Migrations ──────────────────────────────────────────────────────

  /**
   * Register a migration.
   */
  registerMigration(migration: Migration): void {
    this.migrations.set(migration.id, migration);
  }

  /**
   * Run pending migrations.
   */
  async runMigrations(): Promise<Migration[]> {
    if (!this.isInitialized) {
      await this.connect();
    }

    const executedMigrations: Migration[] = [];

    // Create migrations table if it doesn't exist
    await this.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        version VARCHAR(20) NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        executed_by VARCHAR(255)
      )
    `);

    // Execute pending migrations
    for (const [id, migration] of this.migrations) {
      const executed = await this.query("SELECT 1 FROM migrations WHERE id = $1", [id]);

      if (executed.rowCount === 0) {
        try {
          await this.query(migration.sql);
          await this.query(
            "INSERT INTO migrations (id, name, version, executed_by) VALUES ($1, $2, $3, $4)",
            [id, migration.name, migration.version, "system"],
          );
          migration.executedAt = new Date().toISOString();
          executedMigrations.push(migration);
        } catch (error) {
          throw new Error(`Migration ${migration.name} failed: ${error}`);
        }
      }
    }

    return executedMigrations;
  }

  /**
   * Get executed migrations.
   */
  async getExecutedMigrations(): Promise<Migration[]> {
    const result = await this.query("SELECT * FROM migrations ORDER BY executed_at");
    return result.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      executedAt: row.executed_at,
      executedBy: row.executed_by,
      sql: "",
    }));
  }

  // ─── Backup & Restore ────────────────────────────────────────────────

  /**
   * Create a database backup.
   */
  async createBackup(_filename: string): Promise<{ success: boolean; backupFile: string }> {
    // Not implemented. kit does not manage database backups. Throwing keeps this
    // honest instead of returning a fake success that could mask data loss if a
    // caller ever relied on it.
    throw new Error(
      "DatabaseManager.createBackup is not implemented — kit does not perform database backups",
    );
  }

  /**
   * Restore from backup.
   */
  async restoreBackup(_backupFile: string): Promise<{ success: boolean; message: string }> {
    // Not implemented (see createBackup).
    throw new Error(
      "DatabaseManager.restoreBackup is not implemented — kit does not perform database restores",
    );
  }

  // ─── Health & Monitoring ──────────────────────────────────────────────

  /**
   * Check database health.
   */
  async getHealth(): Promise<DatabaseHealth> {
    try {
      const start = Date.now();
      await this.query("SELECT 1");
      const responseTime = Date.now() - start;

      const status = responseTime < 100 ? "healthy" : "degraded";

      return {
        status,
        poolSize: this.config.poolSize || 10,
        activeConnections: this.pool.getActiveCount(),
        idleConnections: this.pool.getIdleCount(),
        waitingRequests: this.pool.getWaitingCount(),
        lastHealthCheck: new Date().toISOString(),
      };
    } catch {
      return {
        status: "unhealthy",
        poolSize: this.config.poolSize || 10,
        activeConnections: 0,
        idleConnections: 0,
        waitingRequests: 0,
        lastHealthCheck: new Date().toISOString(),
      };
    }
  }

  /**
   * Get query statistics.
   */
  getQueryStats(): {
    totalQueries: number;
    averageExecutionTime: number;
    slowestQuery: { sql: string; duration: number } | null;
  } {
    if (this.queryLog.length === 0) {
      return {
        totalQueries: 0,
        averageExecutionTime: 0,
        slowestQuery: null,
      };
    }

    const totalTime = this.queryLog.reduce((sum, q) => sum + q.duration, 0);
    const averageTime = totalTime / this.queryLog.length;
    const slowestQuery = this.queryLog.reduce((max, q) => (q.duration > max.duration ? q : max));

    return {
      totalQueries: this.queryLog.length,
      averageExecutionTime: Math.round(averageTime),
      slowestQuery,
    };
  }

  /**
   * Clear query log (for testing).
   */
  clearQueryLog(): void {
    this.queryLog = [];
  }

  // ─── Utilities ────────────────────────────────────────────────────────

  private logQuery(sql: string, duration: number): void {
    this.queryLog.push({
      sql,
      duration,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 1000 queries
    if (this.queryLog.length > 1000) {
      this.queryLog = this.queryLog.slice(-1000);
    }
  }

  /**
   * Get connection pool info.
   */
  getPoolInfo(): {
    size: number;
    activeConnections: number;
    idleConnections: number;
    maxConnections: number;
  } {
    return {
      size: this.config.poolSize || 10,
      activeConnections: this.pool.getActiveCount(),
      idleConnections: this.pool.getIdleCount(),
      maxConnections: this.config.maxConnections || 20,
    };
  }
}

// ─── Connection Pool ────────────────────────────────────────────────────────

class ConnectionPool {
  private config: DatabaseConfig;
  private available: MockConnection[] = [];
  private active: Set<MockConnection> = new Set();
  private waiting: Array<(conn: MockConnection) => void> = [];

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const poolSize = this.config.poolSize || 10;
    for (let i = 0; i < poolSize; i++) {
      this.available.push(new MockConnection(this.config));
    }
  }

  async getConnection(): Promise<MockConnection> {
    if (this.available.length > 0) {
      const conn = this.available.pop()!;
      this.active.add(conn);
      return conn;
    }

    // Wait for a connection to become available
    return new Promise((resolve) => {
      this.waiting.push((conn) => {
        this.active.add(conn);
        resolve(conn);
      });
    });
  }

  releaseConnection(conn: MockConnection): void {
    this.active.delete(conn);

    if (this.waiting.length > 0) {
      const callback = this.waiting.shift()!;
      callback(conn);
    } else {
      this.available.push(conn);
    }
  }

  getActiveCount(): number {
    return this.active.size;
  }

  getIdleCount(): number {
    return this.available.length;
  }

  getWaitingCount(): number {
    return this.waiting.length;
  }

  async drain(): Promise<void> {
    this.available = [];
    this.active.clear();
    this.waiting = [];
  }
}

// ─── Mock Connection for Testing ────────────────────────────────────────

class MockConnection {
  constructor(config: DatabaseConfig) {
    void config;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    void params;
    // Simulate query execution
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

    // Handle special test queries
    if (sql.includes("SELECT 1")) {
      return {
        rows: [{ test: 1 }],
        rowCount: 1,
      };
    }

    if (sql.includes("CREATE TABLE")) {
      return {
        rows: [],
        rowCount: 0,
      };
    }

    return {
      rows: [],
      rowCount: 0,
    };
  }
}

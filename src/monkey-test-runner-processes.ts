import type { ChildProcess } from "node:child_process";
import { processTreeRunning, stopProcess } from "./monkey-test-process.js";

const activeScopes = new Set<MonkeyProcessScope>();
let shutdown: Promise<void> | undefined;
const onInterrupt = (): void => interruptRuns("SIGINT");
const onTerminate = (): void => interruptRuns("SIGTERM");

function interruptRuns(signal: "SIGINT" | "SIGTERM"): void {
  if (shutdown) return;
  for (const scope of activeScopes) scope.abort();
  shutdown = Promise.all([...activeScopes].map((scope) => scope.stop())).then(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/** Retire completed groups promptly; PGID probes cannot guarantee kernel-level identity. */
export class MonkeyProcessScope {
  private readonly children = new Map<ChildProcess, Promise<boolean> | undefined>();
  private readonly observers = new Map<ChildProcess, NodeJS.Timeout>();
  private readonly controller = new AbortController();
  private stopping?: Promise<void>;
  readonly signal = this.controller.signal;

  constructor() {
    if (activeScopes.size === 0) {
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
    }
    activeScopes.add(this);
    if (shutdown) this.abort();
  }

  add(child: ChildProcess, lifetime: "command" | "server" = "command"): void {
    this.children.set(child, undefined);
    const retire = (): void => {
      if (lifetime === "command") void this.stopChild(child);
      else this.observeServerExit(child);
    };
    child.once("exit", retire);
    child.once("close", retire);
    child.once("error", retire);
  }

  abort(): void {
    this.controller.abort();
  }

  private clearObserver(child: ChildProcess): void {
    clearInterval(this.observers.get(child));
    this.observers.delete(child);
  }

  private retireChild(child: ChildProcess): void {
    this.clearObserver(child);
    this.children.delete(child);
  }

  private observeServerExit(child: ChildProcess): void {
    if (!this.children.has(child) || this.children.get(child)) return;
    if (!processTreeRunning(child)) return this.retireChild(child);
    if (this.observers.has(child)) return;
    const timer = setInterval(() => {
      if (!processTreeRunning(child)) this.retireChild(child);
    }, 25);
    timer.unref();
    this.observers.set(child, timer);
  }

  stopChild(child: ChildProcess): Promise<boolean> {
    if (!this.children.has(child)) return Promise.resolve(true);
    const pending = this.children.get(child);
    if (pending) return pending;
    this.clearObserver(child);
    if (!processTreeRunning(child)) {
      this.retireChild(child);
      return Promise.resolve(true);
    }
    const stopping = stopProcess(child).then((stopped) => {
      if (stopped) this.retireChild(child);
      else this.children.set(child, undefined);
      return stopped;
    });
    this.children.set(child, stopping);
    return stopping;
  }

  stop(): Promise<void> {
    this.stopping ??= Promise.all(
      [...this.children.keys()].map((child) => this.stopChild(child)),
    ).then(() => undefined);
    return this.stopping;
  }

  async close(): Promise<void> {
    await this.stop();
    if (shutdown) await shutdown;
    activeScopes.delete(this);
    if (activeScopes.size === 0) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  }
}

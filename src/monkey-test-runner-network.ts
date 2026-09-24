import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) resolvePort(address.port);
        else reject(new Error("could not allocate a free port"));
      });
    });
    server.on("error", reject);
  });
}

export async function waitForUrl(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, controller.signal]),
        redirect: "manual",
      });
      clearTimeout(timer);
      if (response.status < 500) return true;
    } catch {
      clearTimeout(timer);
    }
    await delay(250, undefined, { signal });
  }
  return false;
}

export function isLoopbackBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}

import { it } from "node:test";
import { checkOfflineOrders } from "./pal-graph-properties.test-support.js";

it("preserves offline chains and every head across all import orders, retries and forwarding (4/4)", () => {
  checkOfflineOrders(20260916, 5);
});

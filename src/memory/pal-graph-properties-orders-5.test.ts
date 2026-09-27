import { it } from "node:test";
import { checkOfflineOrders } from "./pal-graph-properties.test-support.js";

it("preserves offline chains and every head across all import orders, retries and forwarding (5/10)", () => {
  checkOfflineOrders(20260917, 2);
});

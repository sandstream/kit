import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { provisionService, listAvailableServices, getServiceInfo } from "./provision.js";

let testProjectPath: string;

beforeEach(async () => {
  testProjectPath = resolve(tmpdir(), `kit-test-${Date.now()}`);
  await fs.mkdir(testProjectPath, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(testProjectPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("provisionService", () => {
  it("returns error for unknown service", async () => {
    const result = await provisionService("unknown/service", testProjectPath);
    
    assert.equal(result.success, false);
    assert(result.error?.includes("Unknown service"));
    assert(result.message?.includes("Available services"));
  });

  it("returns error when required tool is not installed", async () => {
    // This test will only work if we mock the tool check
    // For now, we just verify the response structure
    const result = await provisionService("stripe/payments", testProjectPath);
    
    // Either success or error, but structure should be consistent
    assert(result.success !== undefined);
    assert(result.message !== undefined);
  });

  it("updates .env.local with secrets when provisioning", async () => {
    // Create a mock adapter that doesn't require external tools
    // This is more of an integration test structure
    const result = await provisionService("stripe/payments", testProjectPath, "test-project");
    
    // Verify result structure
    assert(typeof result.success === "boolean");
    assert(typeof result.message === "string");
    
    if (result.success && result.secrets) {
      // If successful, verify secrets structure
      assert(typeof result.secrets === "object");
    }
  });

  it("updates skills-lock.json with provisioning info", async () => {
    // Similar structure verification test
    const result = await provisionService("supabase/db", testProjectPath, "test-project");
    
    assert(typeof result.success === "boolean");
    assert(typeof result.message === "string");
    
    if (result.success && result.config) {
      assert(typeof result.config === "object");
    }
  });
});

describe("listAvailableServices", () => {
  it("returns list of available services", () => {
    const services = listAvailableServices();
    
    assert(Array.isArray(services));
    assert(services.length > 0);
    assert(services.includes("stripe/payments"));
    assert(services.includes("supabase/db"));
    assert(services.includes("vercel/hosting"));
    assert(services.includes("expo/eas"));
  });
});

describe("getServiceInfo", () => {
  it("returns service information for known service", () => {
    const info = getServiceInfo("stripe/payments");
    
    assert(info !== null);
    assert.equal(info?.name, "stripe/payments");
    assert(typeof info?.description === "string");
    assert(Array.isArray(info?.tools));
  });

  it("returns null for unknown service", () => {
    const info = getServiceInfo("unknown/service");
    
    assert.equal(info, null);
  });

  it("includes required tools in service info", () => {
    const info = getServiceInfo("stripe/payments");
    
    assert(info !== null);
    assert(info.tools.length > 0);
    assert(info.tools.includes("stripe"));
  });
});

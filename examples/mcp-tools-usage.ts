/**
 * kit MCP Tools Usage Examples
 *
 * This file demonstrates how to use the three MCP tools:
 * - kit_configure: Configuration management
 * - kit_adapter_check: Adapter health monitoring
 * - kit_adapter_install: Adapter provisioning
 *
 * Note: Requires MCP connection (Claude Code, MCP-capable clients)
 */

// ─── Configuration Management ────────────────────────────────────────────

/**
 * Example 1: Configure database connection
 */
async function configureDatabase() {
  // Set database configuration value
  const result = await kit_configure({
    action: "set",
    key: "database.url",
    value: "postgres://localhost:5432/kit",
    scope: "project",
    category: "service",
  });

  if (result.success) {
    console.log("Database configured:", result.data?.key);
  } else {
    console.error("Failed to configure:", result.error);
  }
}

/**
 * Example 2: Enable feature flags
 */
async function enableFeatures() {
  const features = [
    { key: "feature.dark_mode", value: "true" },
    { key: "feature.analytics", value: "true" },
    { key: "feature.beta_api", value: "false" },
  ];

  for (const feature of features) {
    const result = await kit_configure({
      action: "set",
      key: feature.key,
      value: feature.value,
      scope: "project",
      category: "feature",
    });

    console.log(`${feature.key}: ${result.success ? "enabled" : "failed"}`);
  }
}

/**
 * Example 3: List all project configuration
 */
async function listProjectConfig() {
  const result = await kit_configure({
    action: "list",
    scope: "project",
  });

  if (result.success) {
    const configs = result.data?.configs ?? [];
    console.log(`Found ${configs.length} configuration values:`);
    configs.forEach((config: any) => {
      console.log(`  ${config.key}: ${config.value} (${config.category})`);
    });
  }
}

/**
 * Example 4: Validate configuration before setting
 */
async function validateConfig() {
  // Check if value is valid for port number
  const validation = await kit_configure({
    action: "validate",
    key: "server.port",
    value: "8080",
  });

  if (validation.result === "valid") {
    console.log("Port configuration is valid");
  } else {
    console.log("Validation warning:", validation.message);
  }
}

// ─── Adapter Health Monitoring ──────────────────────────────────────────

/**
 * Example 5: Check adapter installation and configuration status
 */
async function checkAdapterStatus() {
  const adapters = ["stripe", "github", "slack"];

  for (const adapter of adapters) {
    const result = await kit_adapter_check({
      action: "status",
      adapter,
    });

    if (result.success) {
      const status = result.data;
      console.log(`${adapter}:`);
      console.log(`  Status: ${status?.overall_status}`);
      console.log(`  Installed: ${status?.installed}`);
      console.log(`  Configured: ${status?.configured}`);
      console.log(`  Authenticated: ${status?.authenticated}`);

      if (status?.recommendations && status.recommendations.length > 0) {
        console.log("  Recommendations:");
        status.recommendations.forEach((rec: string) => {
          console.log(`    - ${rec}`);
        });
      }
    } else {
      console.log(`${adapter}: Not configured`);
    }
  }
}

/**
 * Example 6: Verify adapter dependencies
 */
async function checkDependencies() {
  const result = await kit_adapter_check({
    action: "dependencies",
    adapter: "github",
  });

  if (result.success) {
    const deps = result.data ?? [];
    console.log("GitHub adapter dependencies:");
    deps.forEach((dep: any) => {
      const status = dep.installed ? "✓" : "✗";
      console.log(
        `  ${status} ${dep.name} (${dep.version ?? "any"})${!dep.compatible ? " - INCOMPATIBLE" : ""}`,
      );
    });
  }
}

/**
 * Example 7: Monitor adapter health metrics
 */
async function monitorAdapterHealth() {
  const result = await kit_adapter_check({
    action: "health",
    adapter: "sendgrid",
  });

  if (result.success) {
    const health = result.data;
    console.log("SendGrid Adapter Health:");
    console.log(`  Healthy: ${health?.healthy}`);
    console.log(`  Uptime: ${health?.uptime_seconds}s`);
    console.log(`  Errors: ${health?.error_count}`);
    console.log(`  Success: ${health?.success_count}`);
    console.log(`  Avg Response: ${health?.average_response_time_ms}ms`);
  }
}

// ─── Adapter Installation & Setup ──────────────────────────────────────

/**
 * Example 8: Install a new adapter
 */
async function installAdapter() {
  const result = await kit_adapter_install({
    action: "install",
    adapter: "stripe",
    version: "2.0.0",
    auto_configure: false,
  });

  if (result.success) {
    console.log(`${result.data?.adapter_name} installed`);
    if (result.data?.setup_required) {
      console.log("Next steps:");
      result.data?.next_steps?.forEach((step: string) => {
        console.log(`  - ${step}`);
      });
    }
  } else {
    console.error("Installation failed:", result.error);
  }
}

/**
 * Example 9: Setup adapter with auto-configuration
 */
async function setupAdapterAuto() {
  const result = await kit_adapter_install({
    action: "setup",
    adapter: "github",
    mode: "auto",
    env_vars: {
      token: "ghp_xxxxxxxxxxxxx",
      owner: "my-org",
    },
  });

  if (result.success) {
    console.log(`${result.data?.adapter_name} configured`);
    console.log(`Variables set: ${result.data?.env_vars_set?.join(", ")}`);
  }
}

/**
 * Example 10: Setup adapter interactively (simulated)
 */
async function setupAdapterInteractive() {
  // In real usage, gather user input
  const userResponses = {
    api_key: "sk_test_xxx",
    webhook_url: "https://myapp.com/webhooks",
  };

  const result = await kit_adapter_install({
    action: "setup",
    adapter: "stripe",
    mode: "interactive",
    responses: userResponses,
  });

  if (result.success) {
    console.log(`Setup complete. Variables configured: ${result.data?.env_vars_set?.length}`);
  }
}

/**
 * Example 11: Set individual environment variable
 */
async function configureEnvVar() {
  const result = await kit_adapter_install({
    action: "configure",
    key: "STRIPE_API_KEY",
    value: "sk_live_xxxxx",
    adapter: "stripe",
    required: true,
  });

  if (result.success) {
    console.log(`${result.data?.key} configured for ${result.data?.adapter_name}`);
  }
}

// ─── Complete Workflow Examples ──────────────────────────────────────────

/**
 * Example 12: Complete adapter onboarding workflow
 */
async function completeAdapterOnboarding() {
  console.log("Starting Stripe adapter onboarding...\n");

  // Step 1: Install adapter
  console.log("Step 1: Installing adapter...");
  let result = await kit_adapter_install({
    action: "install",
    adapter: "stripe",
    version: "2.0.0",
  });
  if (!result.success) throw new Error("Installation failed");

  // Step 2: Configure environment
  console.log("Step 2: Configuring environment...");
  result = await kit_adapter_install({
    action: "setup",
    adapter: "stripe",
    mode: "auto",
    env_vars: {
      secret_key: "sk_test_xxx",
      publishable_key: "pk_test_xxx",
    },
  });
  if (!result.success) throw new Error("Configuration failed");

  // Step 3: Verify installation
  console.log("Step 3: Verifying installation...");
  const checkResult = await kit_adapter_check({
    action: "status",
    adapter: "stripe",
  });
  if (checkResult.success) {
    const status = checkResult.data;
    if (status?.overall_status === "healthy") {
      console.log("✓ Adapter ready to use");
    } else {
      console.log("⚠ Adapter status:", status?.overall_status);
    }
  }
}

/**
 * Example 13: Diagnose adapter issues
 */
async function diagnoseAdapterIssues(adapterName: string) {
  console.log(`Diagnosing ${adapterName}...\n`);

  // Check status
  const statusResult = await kit_adapter_check({
    action: "status",
    adapter: adapterName,
  });

  if (!statusResult.success) {
    console.log("❌ Adapter not found or not configured");
    return;
  }

  const status = statusResult.data;
  console.log(`Status: ${status?.overall_status}`);
  console.log(`Installed: ${status?.installed}`);
  console.log(`Configured: ${status?.configured}`);
  console.log(`Authenticated: ${status?.authenticated}\n`);

  // Check dependencies
  const depsResult = await kit_adapter_check({
    action: "dependencies",
    adapter: adapterName,
  });

  if (depsResult.success) {
    const deps = depsResult.data ?? [];
    const missing = deps.filter((d: any) => !d.installed);
    if (missing.length > 0) {
      console.log("Missing dependencies:");
      missing.forEach((d: any) => {
        console.log(`  - ${d.name}`);
      });
    }
  }

  // Check health
  const healthResult = await kit_adapter_check({
    action: "health",
    adapter: adapterName,
  });

  if (healthResult.success) {
    const health = healthResult.data;
    console.log(`\nHealth: ${health?.healthy ? "✓ Healthy" : "✗ Unhealthy"}`);
    if (health?.error_count && health.error_count > 0) {
      console.log(`Recent errors: ${health.error_count}`);
    }
  }

  // Show recommendations
  if (status?.recommendations && status.recommendations.length > 0) {
    console.log("\nRecommendations:");
    status.recommendations.forEach((rec: string) => {
      console.log(`  → ${rec}`);
    });
  }
}

/**
 * Example 14: Setup project with multiple adapters
 */
async function setupProjectAdapters() {
  const adapters = [
    { name: "stripe", keys: { secret_key: "sk_test_xxx" } },
    { name: "github", keys: { token: "ghp_xxx" } },
    { name: "slack", keys: { bot_token: "xoxb_xxx" } },
  ];

  console.log("Setting up project adapters...\n");

  for (const adapter of adapters) {
    console.log(`Setting up ${adapter.name}...`);

    // Install
    let result = await kit_adapter_install({
      action: "install",
      adapter: adapter.name,
    });

    if (!result.success) {
      console.log(`  ⚠ Installation skipped: ${result.error}`);
      continue;
    }

    // Configure
    result = await kit_adapter_install({
      action: "setup",
      adapter: adapter.name,
      mode: "auto",
      env_vars: adapter.keys,
    });

    if (result.success) {
      console.log(`  ✓ Configured (${result.data?.env_vars_set?.length} vars)`);
    } else {
      console.log(`  ✗ Configuration failed`);
    }
  }

  console.log("\nProject adapter setup complete");
}

// Export for use in other modules
export {
  configureDatabase,
  enableFeatures,
  listProjectConfig,
  validateConfig,
  checkAdapterStatus,
  checkDependencies,
  monitorAdapterHealth,
  installAdapter,
  setupAdapterAuto,
  setupAdapterInteractive,
  configureEnvVar,
  completeAdapterOnboarding,
  diagnoseAdapterIssues,
  setupProjectAdapters,
};

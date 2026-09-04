import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gateInstall } from "./triage-gate.js";
import { exec } from "./utils/exec.js";

const PLUGIN_PREFIX = "kit-plugin-";
const SHORT_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const PLUGIN_DEV_DEPENDENCIES = {
  "@types/node": "^22.0.0",
  typescript: "^5.9.3",
} as const;

export interface CreatePluginOptions {
  /** Plugin short name, e.g. "aws-s3" → package "kit-plugin-aws-s3" */
  name: string;
  /** Directory to create the plugin in (defaults to cwd) */
  cwd?: string;
  /** Skip running npm install after scaffolding */
  skipInstall?: boolean;
}

export interface CreatePluginResult {
  success: boolean;
  pluginDir: string;
  packageName: string;
  message: string;
  nextSteps: string[];
}

export interface CreatePluginDeps {
  gateInstall: typeof gateInstall;
  exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

const defaultDeps: CreatePluginDeps = { gateInstall, exec };

function normalizePluginName(name: string): string {
  if (typeof name !== "string" || name !== name.trim()) {
    throw new Error(`Invalid plugin scaffold name ${JSON.stringify(name)}`);
  }

  const shortName = name.startsWith(PLUGIN_PREFIX) ? name.slice(PLUGIN_PREFIX.length) : name;
  const packageName = `${PLUGIN_PREFIX}${shortName}`;
  if (
    !SHORT_NAME_RE.test(shortName) ||
    shortName.startsWith(PLUGIN_PREFIX) ||
    packageName.length > 214
  ) {
    throw new Error(
      `Invalid plugin scaffold name ${JSON.stringify(name)}; use a lowercase npm slug`,
    );
  }
  return shortName;
}

/**
 * Scaffold a new kit adapter plugin from the reference template.
 *
 * Creates `./kit-plugin-<name>/` with a working TypeScript adapter
 * that builds and passes tests immediately.
 */
export async function createPlugin(
  opts: CreatePluginOptions,
  deps: CreatePluginDeps = defaultDeps,
): Promise<CreatePluginResult> {
  const { name } = opts;
  const cwd = resolve(opts.cwd ?? process.cwd());

  // Normalise: strip "kit-plugin-" prefix if the user passed the full name.
  // Community plugins use the unscoped `kit-plugin-<name>` convention (cf. eslint-plugin-*);
  // only first-party packages live under the @sandstream scope.
  const shortName = normalizePluginName(name);
  const packageName = `${PLUGIN_PREFIX}${shortName}`;
  const pluginDir = resolve(cwd, packageName);
  const pluginRelative = relative(cwd, pluginDir);
  if (
    pluginRelative === "" ||
    pluginRelative === ".." ||
    pluginRelative.startsWith("../") ||
    pluginRelative.startsWith("..\\") ||
    isAbsolute(pluginRelative)
  ) {
    throw new Error(`Invalid plugin scaffold name ${JSON.stringify(name)}; path escapes cwd`);
  }

  // Capitalise for class/export names: "aws-s3" → "AwsS3", "my-service" → "MyService"
  const titleCase = shortName
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

  const adapterName = `${titleCase.charAt(0).toLowerCase()}${titleCase.slice(1)}Adapter`;
  const serviceName = shortName; // e.g. "aws-s3/deploy" — user can change

  await mkdir(cwd, { recursive: true });
  try {
    await mkdir(pluginDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Plugin scaffold path already exists: ${pluginDir}`, { cause: error });
    }
    throw error;
  }
  await mkdir(join(pluginDir, "src"), { recursive: true });

  const typesDir = join(pluginDir, "src", "types");
  await mkdir(typesDir, { recursive: true });

  await writeFile(join(pluginDir, "package.json"), packageJsonTemplate(packageName), "utf-8");
  await writeFile(join(pluginDir, "tsconfig.json"), tsconfigTemplate(), "utf-8");
  await writeFile(join(pluginDir, "README.md"), readmeTemplate(packageName, shortName), "utf-8");
  await writeFile(join(typesDir, "adapter-sdk.d.ts"), adapterSdkStub(), "utf-8");
  await writeFile(
    join(pluginDir, "src", `${shortName}.ts`),
    adapterTemplate(adapterName, serviceName),
    "utf-8",
  );
  await writeFile(
    join(pluginDir, "src", `${shortName}.test.ts`),
    testTemplate(adapterName, serviceName),
    "utf-8",
  );
  await writeFile(
    join(pluginDir, "src", "index.ts"),
    indexTemplate(adapterName, shortName),
    "utf-8",
  );

  let installMessage: string | undefined;
  let blockedTarget: string | undefined;
  if (!opts.skipInstall) {
    for (const [dependency, version] of Object.entries(PLUGIN_DEV_DEPENDENCIES)) {
      const target = `${dependency}@${version}`;
      const verdict = await deps.gateInstall(`npm:${target}`);
      if (verdict.decision === "blocked") {
        blockedTarget = target;
        installMessage = `Dependency install skipped: triage blocked ${target}: ${verdict.reason}`;
        break;
      }
    }

    if (!blockedTarget) {
      try {
        await deps.exec("npm", ["install"], { cwd: pluginDir, timeout: 60_000 });
      } catch {
        installMessage = "Dependency install failed; run npm install after resolving the error.";
      }
    }
  }

  const nextSteps = [
    `cd ${packageName}`,
    `npm run build`,
    `npm test`,
    `# Edit src/${shortName}.ts to implement your adapter`,
    `# Then publish: npm publish`,
    `# And add to your project: { "kitPlugins": ["${packageName}"] }`,
  ];
  if (blockedTarget) {
    nextSteps.splice(1, 0, `kit triage npm ${blockedTarget}`, `npm install`);
  } else if (installMessage) {
    nextSteps.splice(1, 0, `npm install`);
  }

  return {
    success: true,
    pluginDir,
    packageName,
    message: installMessage
      ? `Created ${packageName} in ./${packageName}/; ${installMessage}`
      : `Created ${packageName} in ./${packageName}/`,
    nextSteps,
  };
}

// ─── templates ────────────────────────────────────────────────────────────────

function adapterSdkStub(): string {
  return `/**
 * Bundled type stub for sandstream-kit-adapter-sdk.
 * This file lets the plugin build standalone without installing the SDK package.
 *
 * When sandstream-kit-adapter-sdk is published to npm, you can:
 * 1. Run: npm install --save-dev sandstream-kit-adapter-sdk
 * 2. Remove the paths alias from tsconfig.json
 * 3. Delete this file
 */

export interface ProvisionResult {
  success: boolean;
  message: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  error?: string;
}

export interface AdapterContext {
  projectName?: string;
  projectPath: string;
  existingEnv: Record<string, string>;
}

export interface ServiceAdapter {
  name: string;
  description: string;
  check(context: AdapterContext): Promise<boolean>;
  provision(context: AdapterContext): Promise<ProvisionResult>;
  getRequiredTools(): string[];
}

export interface AdapterRegistry {
  [key: string]: ServiceAdapter;
}
`;
}

function packageJsonTemplate(packageName: string): string {
  return (
    JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        description: `kit adapter plugin for ${packageName}`,
        type: "module",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
          },
        },
        files: ["dist", "!dist/**/*.test.*", "README.md"],
        scripts: {
          build: "tsc",
          test: "node --test dist/*.test.js",
        },
        // sandstream-kit-adapter-sdk types are bundled in src/types/adapter-sdk.d.ts so this
        // plugin builds without any registry dependencies. Once sandstream-kit-adapter-sdk is
        // published, add it here:  peerDependencies: { "sandstream-kit-adapter-sdk": ">=0.1.0" }
        devDependencies: PLUGIN_DEV_DEPENDENCIES,
      },
      null,
      2,
    ) + "\n"
  );
}

function tsconfigTemplate(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          outDir: "dist",
          rootDir: "src",
          strict: true,
          declaration: true,
          declarationMap: true,
          sourceMap: true,
          // baseUrl + paths: maps sandstream-kit-adapter-sdk to the bundled type stub so the
          // plugin builds without installing the SDK package. Once sandstream-kit-adapter-sdk is
          // published to npm, remove these two entries and install the real package.
          baseUrl: "src",
          paths: {
            "sandstream-kit-adapter-sdk": ["types/adapter-sdk.d.ts"],
          },
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n"
  );
}

function adapterTemplate(adapterName: string, serviceName: string): string {
  return `import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";

export const ${adapterName}: ServiceAdapter = {
  name: "${serviceName}/deploy",
  description: "TODO: describe what this adapter provisions",

  // Return CLI tool names required for this adapter.
  // Return an empty array for API-based adapters (no CLI needed).
  getRequiredTools(): string[] {
    return [];
  },

  // Return true if the service is already provisioned.
  async check(context: AdapterContext): Promise<boolean> {
    return !!context.existingEnv["MY_SERVICE_KEY"];
  },

  // Provision the service. Should be idempotent.
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const key = context.existingEnv["MY_SERVICE_KEY"];

    // Key-reuse pattern: return existing key if already set
    if (key) {
      return {
        success: true,
        message: "MY_SERVICE_KEY already configured",
        secrets: { MY_SERVICE_KEY: key },
      };
    }

    // TODO: implement provisioning logic
    return {
      success: false,
      error: "Missing MY_SERVICE_KEY",
      message: [
        "Set MY_SERVICE_KEY in .env.local:",
        "1. Visit https://example.com/dashboard/api-keys",
        "2. Create a new API key",
        "3. Add to .env.local: MY_SERVICE_KEY=your_key_here",
      ].join("\\n"),
    };
  },
};
`;
}

function testTemplate(adapterName: string, serviceName: string): string {
  const importName = adapterName;
  return `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ${importName} } from "./${serviceName}.js";

const ctx = (env: Record<string, string> = {}) => ({
  projectPath: "/tmp/test-project",
  projectName: "test-project",
  existingEnv: env,
});

describe("${importName}", () => {
  it("has correct name", () => {
    assert.equal(${importName}.name, "${serviceName}/deploy");
  });

  it("check returns false when key is absent", async () => {
    assert.equal(await ${importName}.check(ctx()), false);
  });

  it("check returns true when key is present", async () => {
    assert.equal(await ${importName}.check(ctx({ MY_SERVICE_KEY: "test" })), true);
  });

  it("provision returns error when key is missing", async () => {
    const result = await ${importName}.provision(ctx());
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it("provision returns existing key when already set", async () => {
    const result = await ${importName}.provision(ctx({ MY_SERVICE_KEY: "sk_test" }));
    assert.equal(result.success, true);
    assert.equal(result.secrets?.["MY_SERVICE_KEY"], "sk_test");
  });
});
`;
}

function indexTemplate(adapterName: string, shortName: string): string {
  return `export { ${adapterName} as adapter } from "./${shortName}.js";\n`;
}

function readmeTemplate(packageName: string, shortName: string): string {
  return `# ${packageName}

[kit](https://github.com/sandstream/kit) adapter plugin for ${shortName}.

## Installation

\`\`\`bash
npm install --save-dev ${packageName}
\`\`\`

Then register in your \`package.json\`:

\`\`\`json
{
  "kitPlugins": ["${packageName}"]
}
\`\`\`

## Usage

\`\`\`bash
kit add ${shortName}/deploy
\`\`\`

## Development

See [PLUGIN_AUTHORING.md](https://github.com/sandstream/kit/blob/main/PLUGIN_AUTHORING.md) for the full plugin authoring guide.
`;
}

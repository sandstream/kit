import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStack } from "./stack-detector.js";

async function makeProject(
  dir: string,
  files: Record<string, string>
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }
}

describe("detectStack", () => {
  it("detects Next.js project", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-nextjs`);
    await makeProject(dir, {
      "package.json": JSON.stringify({
        dependencies: { next: "14.0.0", react: "18.0.0", "@supabase/supabase-js": "2.0.0" },
        devDependencies: { stripe: "^14.0.0" },
      }),
      "pnpm-lock.yaml": "",
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "typescript");
      assert.equal(stack.framework, "nextjs");
      assert.ok(stack.services.includes("supabase"), `expected supabase in services: ${JSON.stringify(stack.services)}`);
      assert.ok(stack.services.includes("stripe"), `expected stripe in services: ${JSON.stringify(stack.services)}`);
      assert.ok(stack.tools.pnpm, "expected pnpm in tools");
      assert.ok(stack.confidence >= 0.8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Remix project", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-remix`);
    await makeProject(dir, {
      "package.json": JSON.stringify({
        dependencies: { "@remix-run/node": "^2.0.0", "@remix-run/react": "^2.0.0" },
      }),
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.framework, "remix");
      assert.equal(stack.language, "typescript");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects FastAPI Python project", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-fastapi`);
    await makeProject(dir, {
      "requirements.txt": "fastapi==0.110.0\nuvicorn==0.29.0\n",
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "python");
      assert.equal(stack.framework, "fastapi");
      assert.ok(stack.tools.python, "expected python in tools");
      assert.ok(stack.confidence >= 0.8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects services in a NON-Node project (Python + Stripe + Sentry)", async () => {
    // Regression for the Node-only gap: services used to be [] for python/go/etc.
    const dir = join(tmpdir(), `kit-detect-${process.pid}-py-services`);
    await makeProject(dir, {
      "requirements.txt": "fastapi==0.110.0\nstripe==8.0.0\nsentry-sdk[fastapi]==1.40.0\n",
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "python");
      assert.ok(stack.services.includes("stripe"), `expected stripe: ${JSON.stringify(stack.services)}`);
      assert.ok(stack.services.includes("sentry"), `expected sentry: ${JSON.stringify(stack.services)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Django project via pyproject.toml", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-django`);
    await makeProject(dir, {
      "pyproject.toml": '[tool.poetry.dependencies]\ndjango = "^5.0"\n',
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "python");
      assert.equal(stack.framework, "django");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Go/Gin project", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-gin`);
    await makeProject(dir, {
      "go.mod": "module myapp\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "go");
      assert.equal(stack.framework, "gin");
      assert.ok(stack.tools.go, "expected go in tools");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Rust/Axum project", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-axum`);
    await makeProject(dir, {
      "Cargo.toml": '[package]\nname = "myapp"\n\n[dependencies]\naxum = "0.7"\n',
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "rust");
      assert.equal(stack.framework, "axum");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Laravel PHP project", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-laravel`);
    await makeProject(dir, {
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }),
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "php");
      assert.equal(stack.framework, "laravel");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects service presence from dependencies", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-services`);
    await makeProject(dir, {
      "package.json": JSON.stringify({
        dependencies: {
          next: "14.0.0",
          resend: "^2.0.0",
          "@clerk/nextjs": "^4.0.0",
          "@trigger.dev/sdk": "^2.0.0",
        },
      }),
    });
    try {
      const stack = await detectStack(dir);
      assert.ok(stack.services.includes("resend"), `expected resend: ${JSON.stringify(stack.services)}`);
      assert.ok(stack.services.includes("clerk"), `expected clerk: ${JSON.stringify(stack.services)}`);
      assert.ok(stack.services.includes("trigger"), `expected trigger: ${JSON.stringify(stack.services)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns confidence 0 for empty/unknown directory", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-empty`);
    await mkdir(dir, { recursive: true });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "unknown");
      assert.equal(stack.confidence, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Sentry from @sentry/nextjs dependency", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-sentry`);
    await makeProject(dir, {
      "package.json": JSON.stringify({
        dependencies: { next: "14.0.0", "@sentry/nextjs": "^7.0.0" },
      }),
    });
    try {
      const stack = await detectStack(dir);
      assert.ok(stack.services.includes("sentry"), `expected sentry in services: ${JSON.stringify(stack.services)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Netlify from netlify.toml file", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-netlify`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ dependencies: { astro: "^4.0.0" } }),
      "netlify.toml": "[build]\n  command = 'npm run build'\n",
    });
    try {
      const stack = await detectStack(dir);
      assert.ok(stack.services.includes("netlify"), `expected netlify in services: ${JSON.stringify(stack.services)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Cloudflare Pages from wrangler.toml file", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-cf`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ dependencies: { "@sveltejs/kit": "^2.0.0" } }),
      "wrangler.toml": 'name = "my-worker"\n',
    });
    try {
      const stack = await detectStack(dir);
      assert.ok(
        stack.services.includes("cloudflare-pages"),
        `expected cloudflare-pages in services: ${JSON.stringify(stack.services)}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects TypeORM and Mongoose in NestJS project", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-nestjs`);
    await makeProject(dir, {
      "package.json": JSON.stringify({
        dependencies: {
          "@nestjs/core": "^10.0.0",
          typeorm: "^0.3.0",
          mongoose: "^8.0.0",
        },
      }),
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.framework, "nestjs");
      assert.ok(stack.services.includes("typeorm"), `expected typeorm: ${JSON.stringify(stack.services)}`);
      assert.ok(stack.services.includes("mongoose"), `expected mongoose: ${JSON.stringify(stack.services)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses engines.node version when present", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-node-version`);
    await makeProject(dir, {
      "package.json": JSON.stringify({
        engines: { node: ">=20.0.0" },
        dependencies: { next: "14.0.0" },
      }),
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.tools.node, "20", `expected node=20, got ${stack.tools.node}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects React Native (framework wins over plain react)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-rn`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ dependencies: { react: "18.0.0", "react-native": "0.74.0" } }),
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.framework, "react-native", `got ${stack.framework}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects a Flutter app from pubspec.yaml", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-flutter`);
    await makeProject(dir, {
      "pubspec.yaml": "name: myapp\ndependencies:\n  flutter:\n    sdk: flutter\n",
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "dart");
      assert.equal(stack.framework, "flutter");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects an iOS app from a Podfile", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-ios`);
    await makeProject(dir, { Podfile: "platform :ios, '16.0'\ntarget 'App' do\nend\n" });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "swift");
      assert.equal(stack.framework, "ios");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Android from a build.gradle applying the Android plugin", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-android`);
    await makeProject(dir, {
      "settings.gradle": "include ':app'\n",
      "build.gradle": "plugins { id 'com.android.application' }\n",
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.language, "kotlin");
      assert.equal(stack.framework, "android");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects framework + services from monorepo workspace members (not just root)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-monorepo`);
    await makeProject(dir, {
      // root manifest has only tooling + a workspaces glob
      "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"], devDependencies: { turbo: "2.0.0" } }),
      "apps/web/package.json": JSON.stringify({ dependencies: { next: "14.0.0", stripe: "14.0.0" } }),
      "packages/db/package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "2.0.0" } }),
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.framework, "nextjs", `expected nextjs from apps/web: ${stack.framework}`);
      assert.ok(stack.services.includes("stripe"), `expected stripe: ${JSON.stringify(stack.services)}`);
      assert.ok(stack.services.includes("supabase"), `expected supabase: ${JSON.stringify(stack.services)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects .nvmrc over the default node version", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-nvmrc`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ dependencies: { next: "14.0.0" } }),
      ".nvmrc": "20\n",
    });
    try {
      assert.equal((await detectStack(dir)).tools.node, "20");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(".tool-versions nodejs wins over engines.node", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-toolversions`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ engines: { node: ">=18.0.0" }, dependencies: { next: "14.0.0" } }),
      ".tool-versions": "nodejs 22.11.0\npython 3.11.4\n",
    });
    try {
      assert.equal((await detectStack(dir)).tools.node, "22");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects .python-version for Python projects", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-pyver`);
    await makeProject(dir, { "requirements.txt": "fastapi\n", ".python-version": "3.11\n" });
    try {
      assert.equal((await detectStack(dir)).tools.python, "3.11");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

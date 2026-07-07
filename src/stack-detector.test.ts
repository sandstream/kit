import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStack } from "./stack-detector.js";

async function makeProject(dir: string, files: Record<string, string>): Promise<void> {
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
      assert.ok(
        stack.services.includes("supabase"),
        `expected supabase in services: ${JSON.stringify(stack.services)}`,
      );
      assert.ok(
        stack.services.includes("stripe"),
        `expected stripe in services: ${JSON.stringify(stack.services)}`,
      );
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
      assert.ok(
        stack.services.includes("stripe"),
        `expected stripe: ${JSON.stringify(stack.services)}`,
      );
      assert.ok(
        stack.services.includes("sentry"),
        `expected sentry: ${JSON.stringify(stack.services)}`,
      );
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
      assert.ok(
        stack.services.includes("resend"),
        `expected resend: ${JSON.stringify(stack.services)}`,
      );
      assert.ok(
        stack.services.includes("clerk"),
        `expected clerk: ${JSON.stringify(stack.services)}`,
      );
      assert.ok(
        stack.services.includes("trigger"),
        `expected trigger: ${JSON.stringify(stack.services)}`,
      );
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
      assert.ok(
        stack.services.includes("sentry"),
        `expected sentry in services: ${JSON.stringify(stack.services)}`,
      );
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
      assert.ok(
        stack.services.includes("netlify"),
        `expected netlify in services: ${JSON.stringify(stack.services)}`,
      );
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
        `expected cloudflare-pages in services: ${JSON.stringify(stack.services)}`,
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
      assert.ok(
        stack.services.includes("typeorm"),
        `expected typeorm: ${JSON.stringify(stack.services)}`,
      );
      assert.ok(
        stack.services.includes("mongoose"),
        `expected mongoose: ${JSON.stringify(stack.services)}`,
      );
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
      "package.json": JSON.stringify({
        dependencies: { react: "18.0.0", "react-native": "0.74.0" },
      }),
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
      "package.json": JSON.stringify({
        workspaces: ["apps/*", "packages/*"],
        devDependencies: { turbo: "2.0.0" },
      }),
      "apps/web/package.json": JSON.stringify({
        dependencies: { next: "14.0.0", stripe: "14.0.0" },
      }),
      "packages/db/package.json": JSON.stringify({
        dependencies: { "@supabase/supabase-js": "2.0.0" },
      }),
    });
    try {
      const stack = await detectStack(dir);
      assert.equal(stack.framework, "nextjs", `expected nextjs from apps/web: ${stack.framework}`);
      assert.ok(
        stack.services.includes("stripe"),
        `expected stripe: ${JSON.stringify(stack.services)}`,
      );
      assert.ok(
        stack.services.includes("supabase"),
        `expected supabase: ${JSON.stringify(stack.services)}`,
      );
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
      "package.json": JSON.stringify({
        engines: { node: ">=18.0.0" },
        dependencies: { next: "14.0.0" },
      }),
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

  // --- New ecosystems + polyglot masking (compatibility sweep fixes) ---

  it("detects Ruby from a Gemfile (Rails)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-ruby`);
    await makeProject(dir, { Gemfile: `gem "rails", "~> 7.1"\n` });
    try {
      const s = await detectStack(dir);
      assert.equal(s.language, "ruby");
      assert.equal(s.framework, "rails");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("polyglot masking: a backend Gemfile wins over an asset package.json", async () => {
    // rails/discourse ship a package.json for the asset pipeline; the backend is Ruby.
    const dir = join(tmpdir(), `kit-detect-${process.pid}-polyruby`);
    await makeProject(dir, {
      Gemfile: `gem "rails"\n`,
      "package.json": JSON.stringify({ dependencies: { esbuild: "0.19.0" } }),
    });
    try {
      assert.equal((await detectStack(dir)).language, "ruby");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("polyglot masking: Django (manage.py + pyproject) wins over an asset package.json", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-polypy`);
    await makeProject(dir, {
      "pyproject.toml": '[project]\ndependencies = ["django"]\n',
      "package.json": JSON.stringify({ devDependencies: { webpack: "5.0.0" } }),
    });
    try {
      const s = await detectStack(dir);
      assert.equal(s.language, "python");
      assert.equal(s.framework, "django");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a real JS meta-framework still wins over an incidental backend manifest", async () => {
    // Next.js app that also vendors a go.mod tool — JS remains primary.
    const dir = join(tmpdir(), `kit-detect-${process.pid}-jswins`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "go.mod": "module tool\ngo 1.22\n",
    });
    try {
      const s = await detectStack(dir);
      assert.equal(s.language, "typescript");
      assert.equal(s.framework, "nextjs");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects .NET from global.json even when projects live under src/", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-dotnet`);
    await makeProject(dir, {
      "global.json": `{ "sdk": { "version": "8.0.100" } }`,
      "package.json": JSON.stringify({ devDependencies: { typescript: "5.0.0" } }),
    });
    try {
      assert.equal((await detectStack(dir)).language, "csharp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("JVM: a plain Java Gradle project is Java, not Kotlin", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-java`);
    await makeProject(dir, {
      "build.gradle": `plugins { id 'java' }\ndependencies { implementation 'org.springframework.boot:spring-boot' }\n`,
      "src/main/java/App.java": "class App {}\n",
    });
    try {
      const s = await detectStack(dir);
      assert.equal(s.language, "java");
      assert.equal(s.framework, "spring");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("JVM: Maven pom.xml is Java", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-maven`);
    await makeProject(dir, { "pom.xml": `<project><groupId>com.google.guava</groupId></project>` });
    try {
      assert.equal((await detectStack(dir)).language, "java");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("JVM: a Kotlin Gradle (.kts + kotlin plugin) is Kotlin", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-kt`);
    await makeProject(dir, { "build.gradle.kts": `plugins { kotlin("jvm") version "1.9.0" }\n` });
    try {
      assert.equal((await detectStack(dir)).language, "kotlin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects C from a Makefile + .c sources", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-c`);
    await makeProject(dir, {
      Makefile: "all:\n\tcc main.c\n",
      "main.c": "int main(){return 0;}\n",
    });
    try {
      assert.equal((await detectStack(dir)).language, "c");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects C++ from CMakeLists.txt even with sources in non-standard dirs", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-cpp`);
    await makeProject(dir, {
      "CMakeLists.txt": "project(app)\nadd_executable(app libobs/main.cpp)\n",
      "libobs/main.cpp": "int main(){}\n",
    });
    try {
      assert.equal((await detectStack(dir)).language, "cpp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a bare Makefile with no C/C++ sources is NOT mislabelled C", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-bareMake`);
    await makeProject(dir, { Makefile: "build:\n\tgo build\n", "main.go": "package main\n" });
    try {
      // go.mod-less Go dir: no C sources ⇒ C/C++ detector must decline ⇒ unknown, not "c".
      assert.notEqual((await detectStack(dir)).language, "c");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects exotic ecosystems (Zig via build.zig, even with a CMake bootstrap)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-zig`);
    await makeProject(dir, {
      "build.zig": "pub fn build(b: *std.Build) void {}\n",
      "CMakeLists.txt": "project(zig)\n",
      "src/main.zig": "pub fn main() void {}\n",
    });
    try {
      assert.equal((await detectStack(dir)).language, "zig");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a JS lib with a secondary composer.json (Packagist mirror) stays JS", async () => {
    // chart.js regression: composer.json with no PHP framework must NOT win over package.json.
    const dir = join(tmpdir(), `kit-detect-${process.pid}-chartjs`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ name: "chart.js", devDependencies: { rollup: "4.0.0" } }),
      "composer.json": JSON.stringify({ name: "chartjs/chart.js" }),
    });
    try {
      assert.equal((await detectStack(dir)).language, "typescript");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a JS tool with a native-addon Cargo.toml stays JS", async () => {
    // pnpm regression: a secondary Cargo.toml must NOT win over package.json.
    const dir = join(tmpdir(), `kit-detect-${process.pid}-pnpm`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ name: "pnpm" }),
      "Cargo.toml": '[package]\nname = "pnpm-exe"\n',
    });
    try {
      assert.equal((await detectStack(dir)).language, "typescript");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a Go tool with a secondary Gemfile (gem wrapper, no package.json) is Go", async () => {
    // fzf regression: Go primary; the Gemfile must not make it Ruby.
    const dir = join(tmpdir(), `kit-detect-${process.pid}-fzf`);
    await makeProject(dir, {
      "go.mod": "module fzf\ngo 1.22\n",
      Gemfile: `gem "fzf"\n`,
    });
    try {
      assert.equal((await detectStack(dir)).language, "go");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("build.zig used only as a build tool (no .zig sources) falls through to C", async () => {
    // neovim regression: build.zig + CMake + .c sources ⇒ C, not Zig.
    const dir = join(tmpdir(), `kit-detect-${process.pid}-nvim`);
    await makeProject(dir, {
      "build.zig": "pub fn build() void {}\n",
      "CMakeLists.txt": "project(nvim)\n",
      "src/main.c": "int main(){return 0;}\n",
    });
    try {
      assert.equal((await detectStack(dir)).language, "c");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a C project with a stray Cargo.toml + C sources is C, not Rust (git)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-gitc`);
    await makeProject(dir, {
      "Cargo.toml": '[package]\nname = "contrib"\n',
      Makefile: "all:\n\tcc x.c\n",
      "x.c": "int main(){return 0;}\n",
    });
    try {
      assert.equal((await detectStack(dir)).language, "c");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a C++ project (CMake) with a C#-bindings global.json is C++, not C# (protobuf)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-pb`);
    await makeProject(dir, {
      "CMakeLists.txt": "project(pb)\nadd_library(pb src/pb.cc)\n",
      "global.json": `{ "sdk": { "version": "8.0.0" } }`,
      "src/pb.cc": "int f(){return 0;}\n",
    });
    try {
      assert.equal((await detectStack(dir)).language, "cpp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a C++ project with Python build scripts is C++, not Python (llama.cpp)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-llama`);
    await makeProject(dir, {
      "CMakeLists.txt": "project(llama)\nadd_executable(main src/main.cpp)\n",
      "requirements.txt": "numpy\ntorch\n",
      // a pure-Python sibling packaged with poetry — does NOT make the repo Python
      "pyproject.toml": '[build-system]\nbuild-backend = "poetry.core.masonry.api"\n',
      "src/main.cpp": "int main(){}\n",
    });
    try {
      assert.equal((await detectStack(dir)).language, "cpp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a Python package that compiles a native extension is Python, not C/Rust (Pillow, cryptography)", async () => {
    // setup.py → setuptools compiles the C; the C is the extension, Python is the product.
    const cext = join(tmpdir(), `kit-detect-${process.pid}-pyc`);
    await makeProject(cext, {
      "setup.py": "from setuptools import setup, Extension\nsetup()\n",
      Makefile: "all:\n\tcc ext.c\n",
      "src/_imaging.c": "int f(){return 0;}\n",
    });
    // maturin build-backend → Rust compiled into a Python wheel (pyca/cryptography).
    const rext = join(tmpdir(), `kit-detect-${process.pid}-pyr`);
    await makeProject(rext, {
      "pyproject.toml": '[build-system]\nbuild-backend = "maturin"\n',
      "Cargo.toml": '[package]\nname = "_rust"\n',
      "src/lib.rs": "pub fn f() {}\n",
    });
    try {
      assert.equal((await detectStack(cext)).language, "python");
      assert.equal((await detectStack(rext)).language, "python");
    } finally {
      await rm(cext, { recursive: true, force: true });
      await rm(rext, { recursive: true, force: true });
    }
  });

  it("PHP with .php sources beats an asset package.json even without a framework (phpMyAdmin)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-pma`);
    await makeProject(dir, {
      "composer.json": JSON.stringify({ require: { "phpmyadmin/sql-parser": "^5" } }),
      "package.json": JSON.stringify({ devDependencies: { webpack: "5.0.0" } }),
      "index.php": "<?php echo 1;",
    });
    try {
      assert.equal((await detectStack(dir)).language, "php");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("source census: a manifest-less repo is detected by its dominant source language (WordPress)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-census-unknown`);
    await makeProject(dir, {
      "index.php": "<?php echo 1;",
      "wp-load.php": "<?php",
      "wp-includes/post.php": "<?php",
      "wp-admin/admin.php": "<?php",
      "readme.html": "<html></html>",
    });
    try {
      assert.equal((await detectStack(dir)).language, "php");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("source census: a dominant backend language overrides a bare asset package.json", async () => {
    // A Rails-style repo whose gems live in subdirs (no root Gemfile) but ships an asset
    // package.json: the census sees Ruby dominate and overrides the bare package.json.
    const dir = join(tmpdir(), `kit-detect-${process.pid}-census-override`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ devDependencies: { esbuild: "0.19.0" } }),
      "core/app/models/order.rb": "class Order; end",
      "core/app/models/product.rb": "class Product; end",
      "api/lib/api.rb": "module Api; end",
      "admin/app/controller.rb": "class C; end",
    });
    try {
      assert.equal((await detectStack(dir)).language, "ruby");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("source census does NOT override when JS itself dominates (chart.js + composer mirror)", async () => {
    const dir = join(tmpdir(), `kit-detect-${process.pid}-census-js`);
    await makeProject(dir, {
      "package.json": JSON.stringify({ name: "chart.js" }),
      "composer.json": JSON.stringify({ name: "chartjs/chart.js" }),
      "src/index.js": "export default {}",
      "src/core.js": "export const x = 1",
    });
    try {
      assert.equal((await detectStack(dir)).language, "typescript");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Elixir (mix.exs) and Scala (build.sbt)", async () => {
    const ex = join(tmpdir(), `kit-detect-${process.pid}-ex`);
    const sc = join(tmpdir(), `kit-detect-${process.pid}-sc`);
    await makeProject(ex, { "mix.exs": "defmodule App.MixProject do\nend\n" });
    await makeProject(sc, { "build.sbt": `name := "app"\n` });
    try {
      assert.equal((await detectStack(ex)).language, "elixir");
      assert.equal((await detectStack(sc)).language, "scala");
    } finally {
      await rm(ex, { recursive: true, force: true });
      await rm(sc, { recursive: true, force: true });
    }
  });
});

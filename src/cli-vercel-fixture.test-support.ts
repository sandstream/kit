import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function installFakeVercel(
  dir: string,
  mode: "list" | "push",
): Promise<{ env: Record<string, string> }> {
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const vercelPath = join(binDir, process.platform === "win32" ? "vercel.exe" : "vercel");
  if (process.platform === "win32") {
    await copyFile(process.execPath, vercelPath);
    await copyFile(process.execPath, join(binDir, "mise.exe"));
    await writeFile(
      join(dir, "which"),
      `if (process.argv[2] === 'vercel') process.stdout.write(${JSON.stringify(vercelPath)} + '\\n'); else process.exit(1);`,
    );
    await writeFile(
      join(dir, "env"),
      mode === "list"
        ? `process.stdout.write(JSON.stringify([{key:"NEXT_PUBLIC_SENTRY_DSN",value:["super","secret","dsn","value"].join("-")}]));`
        : `if (process.argv[2] === 'ls') process.stdout.write('[]'); else { require('node:fs').appendFileSync('vercel.log', process.argv.slice(1).join(' ') + '\\n'); process.stdin.resume(); }`,
    );
  } else {
    await writeFile(
      vercelPath,
      mode === "list"
        ? `#!/usr/bin/env node\nif (process.argv[2] === "env" && process.argv[3] === "ls") process.stdout.write(JSON.stringify([{key:"NEXT_PUBLIC_SENTRY_DSN",value:["super","secret","dsn","value"].join("-")}]));\n`
        : `#!/bin/sh\nif [ "$1" = "env" ] && [ "$2" = "ls" ]; then\n  printf '%s\\n' '[]'\n  exit 0\nfi\nprintf '%s\\n' "$*" >> '${join(dir, "vercel.log")}'\ncat >/dev/null\n`,
    );
    await chmod(vercelPath, 0o755);
    const misePath = join(binDir, "mise");
    await writeFile(
      misePath,
      `#!/bin/sh\nif [ "$1" = "which" ] && [ "$2" = "vercel" ]; then\n  printf '%s\\n' '${vercelPath}'\n  exit 0\nfi\nexit 1\n`,
    );
    await chmod(misePath, 0o755);
  }
  return { env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, VERCEL_TOKEN: "" } };
}

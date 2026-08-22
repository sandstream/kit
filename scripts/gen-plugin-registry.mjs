/**
 * Generate the plugin registry from the plugin packages that actually exist.
 *
 * WHY. The hand-written registry claimed things that were not true, and `kit plugin list` rendered
 * them as fact. Measured against npm and GitHub:
 *
 *   - `package: "@kit/plugins/stripe"` — no such package on npm; the real one is
 *     `sandstream-kit-plugin-stripe`, so the printed `install` command could not work;
 *   - `version: "1.0.0"` — the published packages are 0.1.0 / 0.2.0;
 *   - `repository: "https://github.com/sandstream/kit-stripe"` — HTTP 404;
 *   - `rating: 4.8`, `downloads: 1250` — invented, with no source anywhere, and printed as
 *     `★★★★◆ 4.8`;
 *   - `updated: new Date().toISOString()` — evaluated at import, so the registry always claimed to
 *     be current;
 *   - five entries for eleven shipped plugins, so `kit plugin search cloudflare` answered
 *     "No plugins found" about a package published on npm.
 *
 * Everything here is read from the packages' own `package.json`. Fields kit has no local source for
 * — rating, downloads, publish date — are OMITTED rather than estimated; the display code already
 * treats them as optional, so absent means unshown instead of invented.
 *
 * Byte-idempotent: no timestamps, sorted output, Prettier's shape.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "plugin-registry.generated.ts");

/** The monorepo these plugins live in — one real URL rather than eleven invented ones. */
function repositoryUrl() {
  try {
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const raw = typeof root.repository === "string" ? root.repository : root.repository?.url;
    return (raw ?? "https://github.com/sandstream/kit").replace(/^git\+/, "").replace(/\.git$/, "");
  } catch {
    return "https://github.com/sandstream/kit";
  }
}

export function collect() {
  const packagesDir = join(ROOT, "packages");
  const dirs = readdirSync(packagesDir).filter((d) => d.startsWith("kit-plugin-")).sort();
  const repository = repositoryUrl();
  const plugins = [];

  for (const dir of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf-8"));
    } catch {
      continue;
    }
    if (pkg.private === true) continue; // not published: nothing to advertise
    const id = dir.replace(/^kit-plugin-/, "");
    plugins.push({
      name: id,
      description: pkg.description ?? `kit plugin: ${id}`,
      version: pkg.version ?? "0.0.0",
      author: typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? "Sandstream"),
      license: pkg.license ?? "MIT",
      repository,
      package: pkg.name,
      kitVersion: pkg.peerDependencies?.["sandstream-kit"] ?? ">=6.0.0",
      tags: [...new Set([id, ...(pkg.keywords ?? []), "official"])].sort(),
      install: `npm install ${pkg.name}`,
    });
  }
  return plugins;
}

export function render() {
  const plugins = collect();
  const body = plugins
    .map((p) => {
      const lines = [
        "  {",
        `    name: ${JSON.stringify(p.name)},`,
        // Prettier breaks a property whose line exceeds printWidth (100) onto the next line,
        // indented. Emitting that shape here keeps regeneration byte-identical instead of fighting
        // `format:check` — the same trap as scripts/derive-command-flags.mjs, met a second time and
        // handled while writing the generator rather than after misreading its diff.
        ...(() => {
          const inline = `    description: ${JSON.stringify(p.description)},`;
          return inline.length <= 100
            ? [inline]
            : ["    description:", `      ${JSON.stringify(p.description)},`];
        })(),
        `    version: ${JSON.stringify(p.version)},`,
        `    author: ${JSON.stringify(p.author)},`,
        `    license: ${JSON.stringify(p.license)},`,
        `    repository: ${JSON.stringify(p.repository)},`,
        `    package: ${JSON.stringify(p.package)},`,
        `    kitVersion: ${JSON.stringify(p.kitVersion)},`,
        `    tags: [${p.tags.map((t) => JSON.stringify(t)).join(", ")}],`,
        `    install: ${JSON.stringify(p.install)},`,
        "  },",
      ];
      return lines.join("\n");
    })
    .join("\n");

  return `/**
 * kit's OFFICIAL PLUGINS — generated from each plugin package manifest under packages.
 *
 * (The path is spelled out rather than globbed: a literal star-slash inside a block comment ends
 * the comment early, and the first version of this generator emitted a file TypeScript could not
 * parse. Writing it with a backtick broke the generator's own template literal instead.)
 *
 * GENERATED. Regenerate with:  node scripts/gen-plugin-registry.mjs
 * \`plugins-registry.test.ts\` fails when this file drifts from the packages on disk, so a shipped
 * plugin cannot stay invisible and an entry cannot describe a package that does not exist.
 *
 * The hand-written table this replaces advertised npm packages that were never published
 * (\`@kit/plugins/stripe\`), a 404 repository per plugin, versions that did not match the published
 * ones, and invented ratings and download counts that \`kit plugin list\` printed as \`★★★★◆ 4.8\`.
 * Five of eleven shipped plugins were listed at all.
 *
 * Fields with no local source — rating, downloads, publish date — are absent by design. The display
 * code treats them as optional, so absent means unshown rather than estimated.
 */

import type { PluginMetadata } from "./plugins.js";

export const OFFICIAL_PLUGINS: PluginMetadata[] = [
${body}
];
`;
}

function main() {
  const text = render();
  let previous = null;
  try {
    previous = readFileSync(OUT, "utf-8");
  } catch {
    /* first run */
  }
  if (previous === text) {
    console.log("src/plugin-registry.generated.ts already current");
    return;
  }
  writeFileSync(OUT, text, "utf-8");
  console.log(`wrote src/plugin-registry.generated.ts — ${collect().length} plugins`);
}

if (process.argv[1] && process.argv[1].endsWith("gen-plugin-registry.mjs")) main();

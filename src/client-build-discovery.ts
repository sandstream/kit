import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

const JS_FILE = /\.[cm]?js$/i;

async function jsFilesIn(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((name) => JS_FILE.test(name));
  } catch {
    return false;
  }
}

/**
 * A root build directory that looks like it ships to a browser although no framework is declared:
 * an `index.html`, or JavaScript under `assets/` or `static/`, which is what Vite, Rollup and
 * webpack setups emit. A `dist/` with JavaScript only at its top is read as a server or CLI build.
 */
export async function undeclaredBuildDirs(
  root: string,
  buildDirs: readonly string[],
): Promise<{ browser: string[]; js: string[] }> {
  const browser: string[] = [];
  const js: string[] = [];
  for (const dir of buildDirs) {
    const full = join(root, dir);
    const html = await access(join(full, "index.html")).then(
      () => true,
      () => false,
    );
    const assets =
      (await jsFilesIn(join(full, "assets"))) || (await jsFilesIn(join(full, "static")));
    if (html || assets) browser.push(dir);
    else if (await jsFilesIn(full)) js.push(dir);
  }
  return { browser, js };
}

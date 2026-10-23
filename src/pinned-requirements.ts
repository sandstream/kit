/**
 * Which `requirements.txt` lines are NOT pinned to one exact version. Pure.
 *
 * A line is pinned only when it names one exact version: `name==1.2.3` or `name===1.2.3`,
 * optionally with extras (`name[x]==1`) and an environment marker (`; python_version<"4"`).
 * Everything else is unpinned, including the forms an operator-only test misses: a bare
 * `fastapi` (no version at all), `fastapi<1`, `fastapi==1.*`, and a direct URL reference
 * `fastapi @ https://…`, which is whatever that URL serves today.
 *
 * Option lines (`-r`, `-c`, `-e`, `--hash`, `--index-url`, …) are not requirement specs
 * and are skipped. That includes `-e <vcs-url>`, which can move: a declared limit, not a
 * verdict on it.
 */
const PINNED = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?\s*===?\s*[^\s,;*<>=!~]+\s*(;.*)?$/;

export function unpinnedRequirements(content: string): string[] {
  const unpinned: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw
      .replace(/\s+#.*$/, "")
      .replace(/\\$/, "")
      .trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    if (!PINNED.test(line)) unpinned.push(line.split(/[\s<>=!~;@[]/)[0]);
  }
  return unpinned;
}

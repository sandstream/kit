/**
 * The PyPI side of the cooling period (Z6), and the pip spec kit accepts.
 *
 * `kit triage npm` warned about a release younger than the limit; `kit triage pip` did not, so a
 * four-day-old semgrep passed where a one-day-old jscpd got the warning (kit-research
 * `upstream-watch-2026-11-09`). PyPI's JSON API gives an upload time per file, which is enough:
 * a version's publish time is the earliest upload among its files.
 *
 * `name@1.2.3` is npm's syntax. pip spells it `name==1.2.3`, and the frozen triage.py read the
 * `@1.2.3` as an unresolvable version spec and failed with a CRITICAL. kit now reads the npm form
 * for pip too and says that it did.
 */

/** The distribution name of a pip target such as `semgrep`, `semgrep==1.2` or `requests[socks]>=2`. */
export function pipName(target: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[\w,.-]*\])?\s*(?:[=<>!~]=?.*)?$/.exec(
    target.trim(),
  );
  return m ? m[1] : null;
}

/**
 * `name@version` (npm's form) as pip's `name==version`, or null when the target is not that form.
 * A PEP 508 direct reference (`name @ https://…`) is left alone: it has a URL, not a version.
 */
export function pipSpecFromAt(target: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[\w,.-]*\])?)@([0-9][0-9A-Za-z.!+-]*)$/.exec(
    target.trim(),
  );
  return m ? `${m[1]}==${m[2]}` : null;
}

interface PypiFile {
  upload_time_iso_8601?: unknown;
  upload_time?: unknown;
  yanked?: unknown;
}

/**
 * The published versions of a PyPI JSON document and each one's publish time (its earliest
 * file upload). A version with no files, or whose files are all yanked, is not published. Pure.
 */
export function pypiReleaseTimes(
  doc: unknown,
): { versions: string[]; times: Record<string, string> } | null {
  const releases = (doc as { releases?: unknown } | null)?.releases;
  if (!releases || typeof releases !== "object") return null;
  const times: Record<string, string> = {};
  for (const [version, files] of Object.entries(releases as Record<string, unknown>)) {
    if (!Array.isArray(files)) continue;
    const uploads = (files as PypiFile[])
      .filter((f) => f && f.yanked !== true)
      .map((f) => f.upload_time_iso_8601 ?? f.upload_time)
      .filter((t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    if (uploads.length > 0) times[version] = uploads[0];
  }
  return { versions: Object.keys(times), times };
}

/** The JSON API URL for one distribution on a PyPI-compatible index. */
export function pypiJsonUrl(index: string, name: string): string {
  return `${index.replace(/\/+$/, "")}/pypi/${encodeURIComponent(name)}/json`;
}

/** Parsed git remote: the host and the owner/repo path (no `.git`, no leading slash). */
export interface RemoteSlug {
  host: string;
  path: string;
}

/**
 * Parse a git remote URL into { host, path }. Handles both SSH
 * (`git@gitlab.com:group/sub/repo.git`) and HTTPS
 * (`https://bitbucket.org/ws/repo.git`) forms. Returns null if unparseable.
 * `path` keeps nested groups (GitLab subgroups) and drops a trailing `.git`.
 */
export function parseGitRemote(url: string): RemoteSlug | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH: git@host:owner/repo(.git)  or  ssh://git@host/owner/repo(.git)
  const ssh = trimmed.match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+?)(?:\.git)?$/);
  if (ssh) return { host: ssh[1], path: stripGit(ssh[2]) };

  // HTTPS/HTTP: https://host/owner/repo(.git)
  const https = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { host: https[1], path: stripGit(https[2]) };

  return null;
}

function stripGit(p: string): string {
  return p
    .replace(/\.git$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

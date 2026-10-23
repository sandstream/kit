/**
 * The row text of the `trivy container scan` check. The name is kept because baselines and
 * coverage mappings key on it, but the check runs `trivy fs` on the project files: it never scans
 * a built image, so its text says so and points to `[scan].images`, which does.
 */
export function describeTrivyFsResult(count: number): {
  status: "pass" | "fail";
  detail: string;
  severity?: "high";
} {
  if (count === 0) {
    return {
      status: "pass",
      detail:
        "no high/critical vulnerabilities in the project files (trivy fs). The built image is not scanned: list it in [scan].images",
    };
  }
  return {
    status: "fail",
    detail: `${count} high/critical vulnerability(ies) in the project files (trivy fs). The built image is not scanned: list it in [scan].images`,
    severity: "high",
  };
}

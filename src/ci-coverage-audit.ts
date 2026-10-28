/** Read-only CI gate and deployment image tag audit. */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

interface SourceFile {
  name: string;
  content: string;
}
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 1_000;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "vendor",
  "target",
  ".venv",
  "venv",
  ".terraform",
  ".gradle",
  ".cache",
  "Pods",
  "out",
]);

function directoryWithoutLink(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readBounded(root: string, name: string, errors: string[]): SourceFile | null {
  let fd: number;
  try {
    fd = openSync(join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    errors.push(name);
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("not a bounded regular file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const size = readSync(fd, buffer, length, buffer.length - length, null);
      if (!size) break;
      length += size;
    }
    if (length > MAX_BYTES) throw new Error("file grew while scanning");
    return { name, content: buffer.subarray(0, length).toString("utf8") };
  } catch {
    errors.push(name);
    return null;
  } finally {
    closeSync(fd);
  }
}

function collect(root: string): { ci: SourceFile[]; deploy: SourceFile[]; errors: string[] } {
  const ci: SourceFile[] = [];
  const deploy: SourceFile[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const add = (name: string, target: SourceFile[]) => {
    if (seen.has(name)) {
      const existing = ci.find((f) => f.name === name) ?? deploy.find((f) => f.name === name);
      if (existing && !target.includes(existing)) target.push(existing);
      return;
    }
    if (seen.size >= MAX_FILES) {
      errors.push("file limit reached");
      return;
    }
    seen.add(name);
    const file = readBounded(root, name, errors);
    if (file) target.push(file);
  };
  for (const name of [".gitlab-ci.yml", "bitbucket-pipelines.yml"]) {
    if (existsSync(join(root, name))) {
      add(name, ci);
      add(name, deploy);
    }
  }
  const githubDir = join(root, ".github");
  const workflowDir = join(githubDir, "workflows");
  const githubDirSafe = directoryWithoutLink(githubDir);
  if (githubDirSafe && directoryWithoutLink(workflowDir)) {
    try {
      for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
        if (!/\.ya?ml$/i.test(entry.name)) continue;
        const name = `.github/workflows/${entry.name}`;
        add(name, ci);
        add(name, deploy);
      }
    } catch {
      errors.push(".github/workflows");
    }
  } else if (existsSync(workflowDir) || (existsSync(githubDir) && !githubDirSafe))
    errors.push(".github/workflows");
  for (const name of ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"]) {
    if (existsSync(join(root, name))) add(name, deploy);
  }
  let directories = 0;
  const visitScripts = (dir: string, depth: number) => {
    directories++;
    if (depth > 8 || directories > 2_000) {
      errors.push(relative(root, dir));
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      errors.push(relative(root, dir));
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) visitScripts(path, depth + 1);
      else if (entry.isFile() && /\.(?:sh|bash|zsh)$/i.test(entry.name))
        add(relative(root, path).replaceAll("\\", "/"), deploy);
    }
  };
  visitScripts(root, 0);
  return { ci, deploy, errors };
}

const INLINE_COMMENT = new RegExp("\\s+#\\s.*$");

function activeLines(content: string): string[] {
  return content
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("#") ? "" : trimmed.replace(INLINE_COMMENT, "");
    });
}

const COMMAND_PREFIX = new RegExp("^\\s*(?:-\\s*)?(?:run:|script:)?\\s*");
const GATE_NAMES = ["kit check", "kit scan", "osv", "trivy"] as const;
const KIT_COMMAND = new RegExp(
  "^(?:(?:npx|pnpm\\s+dlx|bunx)\\s+(?:--yes\\s+)?(?:sandstream-kit|kit)|(?:node\\s+\\S*/cli\\.js)|kit)\\s+(check|scan)\\b",
  "i",
);

function gatePresence(
  files: SourceFile[],
): Record<"kit check" | "kit scan" | "osv" | "trivy", boolean> {
  const present = { "kit check": false, "kit scan": false, osv: false, trivy: false };
  for (const file of files) {
    for (const line of activeLines(file.content)) {
      // Require a command position or a `uses:` action. A job name or echo text is not a gate.
      const command = line.replace(COMMAND_PREFIX, "").trim();
      const kit = KIT_COMMAND.exec(command);
      if (kit?.[1] === "check") present["kit check"] = true;
      if (kit?.[1] === "scan") present["kit scan"] = true;
      if (
        command === "osv-scanner" ||
        command.startsWith("osv-scanner ") ||
        (command.startsWith("uses:") && command.includes("osv-scanner/"))
      )
        present.osv = true;
      if (
        command === "trivy" ||
        command.startsWith("trivy ") ||
        (command.startsWith("uses:") && command.includes("aquasecurity/trivy-action@"))
      )
        present.trivy = true;
    }
  }
  return present;
}

/** Report which of four security commands actually appears in CI. */
export function auditCiCoverage(root: string): SecurityCheckResult[] {
  const { ci, errors: allErrors } = collect(root);
  const errors = allErrors.filter(
    (name) =>
      name === ".gitlab-ci.yml" ||
      name === "bitbucket-pipelines.yml" ||
      name.startsWith(".github/workflows") ||
      name === "file limit reached",
  );
  if (!ci.length && !existsSync(join(root, ".kit.toml")) && !errors.length)
    return [
      {
        category: "supply-chain",
        name: "CI gate coverage",
        status: "skip",
        detail: "no kit config or pipeline",
      },
    ];
  const present = gatePresence(ci);
  const detail = GATE_NAMES.map((key) => `${key}: ${present[key] ? "present" : "missing"}`).join(
    ", ",
  );
  const kitGate = present["kit check"] || present["kit scan"];
  const unreadable = errors.length ? `; ${errors.length} unreadable` : "";
  return [
    {
      category: "supply-chain",
      name: "CI gate coverage",
      status: errors.length || !kitGate ? "warn" : "pass",
      severity: !kitGate ? "medium" : undefined,
      detail: `${ci.length} pipeline file(s); ${detail}${unreadable}`,
      suggestion: !kitGate ? "run kit check or kit scan in a pipeline job" : undefined,
      didNotRun: errors.length > 0,
    },
  ];
}

const BRANCH_REF = new RegExp(
  "\\$\\{?\\{?\\s*(?:github\\.(?:ref_name|head_ref)|env\\.GITHUB_REF_NAME|CI_COMMIT_(?:REF_NAME|REF_SLUG|BRANCH)|BITBUCKET_BRANCH|GITHUB_REF_NAME|BRANCH_NAME)\\b",
  "i",
);
const IMAGE_TAG_VAR = new RegExp(
  "^\\s*(?:-\\s*)?(?:IMAGE_TAG|DOCKER_IMAGE_TAG|CONTAINER_TAG)\\s*[:=]\\s*(.+)$",
  "i",
);
const DEPLOY_COMMAND = new RegExp(
  "\\b(?:docker\\s+(?:build|buildx\\s+build|tag|push)|kubectl\\s+set\\s+image|helm\\s+(?:install|upgrade))\\b",
  "i",
);
const COMPOSE_IMAGE = new RegExp("^\\s*image:\\s*(\\S+)", "i");
const LATEST_TAG = new RegExp(":latest(?=$|\\s|\\}|\\x22|\\x27)", "i");
const LATEST_VARIABLE = new RegExp("^(?:\\x22|\\x27)?latest(?:\\x22|\\x27)?\\s*$", "i");
const IMAGE_SUPPRESSION = new RegExp("kit-ignore\\s+L3-image-tag:\\s*\\S", "i");
const COMPOSE_FILE = new RegExp("^(?:docker-)?compose\\.ya?ml$", "i");

function mutableTag(value: string): boolean {
  return LATEST_TAG.test(value) || BRANCH_REF.test(value);
}

function riskyImageLine(line: string, file: string): boolean {
  if (IMAGE_SUPPRESSION.test(line)) return false;
  const variable = IMAGE_TAG_VAR.exec(line);
  if (variable)
    return LATEST_VARIABLE.test(variable[1] ?? "") || BRANCH_REF.test(variable[1] ?? "");
  if (DEPLOY_COMMAND.test(line)) return mutableTag(line);
  if (COMPOSE_FILE.test(file)) {
    const image = COMPOSE_IMAGE.exec(line);
    if (image) return mutableTag(image[1] ?? "");
  }
  return false;
}

/** Detect mutable deployment image tags in scripts, Compose and CI variables. */
export function auditDeploymentImageTags(root: string): SecurityCheckResult[] {
  const { deploy, errors } = collect(root);
  const hits: string[] = [];
  for (const file of deploy) {
    activeLines(file.content).forEach((line, index) => {
      if (riskyImageLine(line, file.name)) hits.push(`${file.name}:${index + 1}`);
    });
  }
  return [
    {
      category: "supply-chain",
      name: "deployment image tags",
      status: hits.length || errors.length ? "warn" : deploy.length ? "pass" : "skip",
      severity: hits.length ? "medium" : undefined,
      detail: hits.length
        ? `${hits.length} mutable deployment tag(s): ${hits.slice(0, 5).join(", ")}`
        : errors.length
          ? `${errors.length} source file(s) not scanned`
          : deploy.length
            ? "no latest or branch-named deployment image tags"
            : "no deployment files to scan",
      files: [...new Set(hits.map((hit) => hit.replace(/:\d+$/, "")))],
      suggestion: hits.length ? "use an immutable release version or image digest" : undefined,
      didNotRun: errors.length > 0,
    },
  ];
}

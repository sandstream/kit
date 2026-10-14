import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MonkeyPackageJson, MonkeyRequirements } from "./monkey-test-contract.js";
import {
  allMonkeyDependencies,
  detectPaymentProviders,
  readMonkeyJson,
  readMonkeyText,
  scanMonkeySources,
  withoutMonkeySourceComments,
} from "./monkey-test-scan.js";

export const MONKEY_ROLE_MATRIX_PATH = ".kit/monkey-test/role-matrix.json";

/** Packages whose presence means the app has signed-in users, and so roles to separate. */
const AUTH_DEPENDENCY =
  /^(?:next-auth|@auth\/.+|@clerk\/.+|@supabase\/(?:supabase-js|ssr|auth-helpers-.+)|firebase|firebase-admin|lucia|passport|@auth0\/.+|better-auth|@kinde-oss\/.+|keycloak-js|oidc-client-ts|iron-session|express-session|@okta\/.+|@azure\/msal-.+|@workos-inc\/.+|supertokens-.+|devise)$/;

/**
 * Source shapes that check a role or an authenticated user. Lexical, like the rest of
 * the static pass: a false positive restores the full gate, which is the safe direction.
 */
const ROLE_SOURCE_MARKERS: RegExp[] = [
  /\bcreate\s+policy\b/i,
  /\b(?:hasRole|requireRole|checkRole|assertRole|requireAuth|getServerSession|currentUser)\s*\(/,
  /\.role\s*={2,3}\s*["'`]/,
  /\brole\s*={2,3}\s*["'`]/,
  /\bauth\.uid\s*\(\)/,
];

function authDependencies(deps: Record<string, string>): string[] {
  return Object.keys(deps)
    .filter((name) => AUTH_DEPENDENCY.test(name))
    .sort();
}

function roleSourceFile(files: Record<string, string>): string | undefined {
  const clean = withoutMonkeySourceComments(files);
  return Object.keys(clean)
    .sort()
    .find((path) => ROLE_SOURCE_MARKERS.some((marker) => marker.test(clean[path])));
}

/**
 * What the existing role matrix says about roles. `absent` and `public-only` leave the
 * decision to detection. Anything else (more roles, or a file that does not parse) keeps
 * roles required: an operator who wrote five roles has five roles, and a broken file
 * must not quietly shrink the gate.
 */
async function matrixRoleDeclaration(
  root: string,
): Promise<"absent" | "public-only" | "roles" | "unreadable"> {
  const path = join(root, MONKEY_ROLE_MATRIX_PATH);
  if (!existsSync(path)) return "absent";
  let matrix: unknown;
  try {
    matrix = JSON.parse(await readMonkeyText(path));
  } catch {
    return "unreadable";
  }
  const roles = (matrix as { roles?: unknown } | null)?.roles;
  if (!Array.isArray(roles)) return "unreadable";
  const ids = roles.map((role) => (role as { id?: unknown } | null)?.id);
  return ids.length === 1 && ids[0] === "public" ? "public-only" : "roles";
}

export interface MonkeyRequirementInput {
  root: string;
  deps: Record<string, string>;
  runtimeFiles: Record<string, string>;
  providers: string[];
}

export async function monkeyRequirementsFrom(
  input: MonkeyRequirementInput,
): Promise<MonkeyRequirements> {
  const { root, deps, runtimeFiles, providers } = input;
  const money: MonkeyRequirements["money"] =
    providers.length > 0
      ? { required: true, reason: `payment provider detected: ${providers.join(", ")}` }
      : { required: false, reason: "no payment provider marker detected" };
  const declaration = await matrixRoleDeclaration(root);
  const auth = authDependencies(deps);
  const sourceFile = auth.length === 0 ? roleSourceFile(runtimeFiles) : undefined;
  let roles: MonkeyRequirements["roles"];
  if (money.required) {
    roles = { required: true, reason: "the money flow runs as a signed-in customer" };
  } else if (auth.length > 0) {
    roles = { required: true, reason: `auth dependency: ${auth.join(", ")}` };
  } else if (sourceFile) {
    roles = { required: true, reason: `role or auth check in ${sourceFile}` };
  } else if (declaration === "roles") {
    roles = { required: true, reason: `role matrix ${MONKEY_ROLE_MATRIX_PATH} declares roles` };
  } else if (declaration === "unreadable") {
    roles = {
      required: true,
      reason: `role matrix ${MONKEY_ROLE_MATRIX_PATH} cannot be read; fail closed`,
    };
  } else {
    roles = { required: false, reason: "no auth dependency, role check, or declared role" };
  }
  return { roles, money };
}

/** Requirements for a repo on disk, for callers that have not scanned it already. */
export async function detectMonkeyRequirements(root: string): Promise<MonkeyRequirements> {
  const pkg = await readMonkeyJson<MonkeyPackageJson>(join(root, "package.json"));
  const deps = allMonkeyDependencies(pkg);
  const scan = await scanMonkeySources(root);
  return monkeyRequirementsFrom({
    root,
    deps,
    runtimeFiles: scan.runtimeFiles,
    providers: detectPaymentProviders(deps, scan.runtimeFiles),
  });
}

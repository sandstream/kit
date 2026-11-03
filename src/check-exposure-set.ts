/** The project-level exposure checks that run together: client env names, built bundle, anonymous database access. */

import type { kitConfig } from "./config.js";
import type { SecurityCheckResult } from "./check-security.js";

export async function checkExposureSet(
  root: string,
  governed: kitConfig | null,
): Promise<SecurityCheckResult[]> {
  const { checkClientExposedNames, checkBuiltBundleSecrets } =
    await import("./check-client-exposure.js");
  const { checkAnonAccess } = await import("./check-anon-access.js");
  const clientAllow: Record<string, string> = governed?.scan?.client_exposed_allow ?? {};
  const declaredKeyNames: string[] = Object.keys(governed?.secrets?.keys ?? {});
  return [
    await checkClientExposedNames(root, clientAllow, declaredKeyNames),
    await checkBuiltBundleSecrets(root),
    await checkAnonAccess(root),
  ];
}

// `kit verify-provenance` command — extracted from cli.ts (incremental split).
import { existsSync } from "node:fs";
import { loadConfig, type kitConfig } from "../config.js";
import { c } from "../utils/colors.js";
import { flagValue } from "../utils/flags.js";
import { resolveConfigPath } from "../cli-shared.js";

export async function cmdVerifyProvenance(): Promise<boolean> {
  const args = process.argv.slice(3);
  // First positional that isn't a value-flag's argument = the artifact.
  const VALUE_FLAGS = new Set(["--bundle", "--trusted-root", "--identity", "--issuer"]);
  let artifact: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("-")) {
      artifact = args[i];
      break;
    }
  }
  if (!artifact) {
    console.error(
      "usage: kit verify-provenance <artifact> --bundle <file> [--trusted-root <f>] [--identity <id>] [--issuer <iss>]",
    );
    return false;
  }
  const { resolveAirGap } = await import("../airgap/config.js");
  const { verifyProvenance } = await import("../airgap/provenance.js");
  const { resolveToolBin } = await import("../utils/resolveTool.js");
  const { execFileNoThrow } = await import("../utils/execFileNoThrow.js");
  // Config-free: verifying a provenance bundle needs the artifact + bundle, not
  // .kit.toml. Missing config is not an error — only [air_gap] trust settings are
  // read (optional). Mirrors `kit scan`.
  const config = existsSync(resolveConfigPath())
    ? await loadConfig(resolveConfigPath())
    : ({} as kitConfig);
  const ag = resolveAirGap(config.air_gap, process.env);
  const res = await verifyProvenance(
    {
      artifact,
      bundle: flagValue(args, "--bundle"),
      trustedRoot: flagValue(args, "--trusted-root") ?? ag.provenanceTrustedRoot,
      certIdentity: flagValue(args, "--identity") ?? ag.provenanceCertIdentity,
      certIssuer: flagValue(args, "--issuer") ?? ag.provenanceCertIssuer,
    },
    {
      resolveBin: (b) => resolveToolBin(b),
      run: async (b, a) => {
        const r = await execFileNoThrow(b, a, { timeout: 60_000 });
        return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
      },
    },
  );
  if (res.ok) {
    console.log(`${c.green}✓ provenance verified${c.reset}  ${c.dim}${artifact}${c.reset}`);
    return true;
  }
  console.error(`${c.red}✗ ${res.reason}${c.reset}`);
  return false;
}

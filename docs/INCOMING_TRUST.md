# `kit security incoming`

Operator commands over the incoming-trust authority store.

```
kit security incoming enroll --authority <file>
kit security incoming status
kit security incoming stage --source <dir> --snapshot-dir <new dir> --origin <https url>
kit security incoming request --checks <file> [--out <file>]
kit security incoming approve --verification <file> --approval <file>
kit security incoming preflight --snapshot-dir <dir> --verification <file> [--sealed]
kit security incoming run-policy --policy <file>
kit security incoming run --snapshot-dir <dir> --verification <file> --policy <file> --json
kit security incoming reject
kit security incoming retry
kit security incoming rotate --signers <file>
kit security incoming recover --acknowledge <text>
```

All subcommands accept `--repo <dir>`, `--store <dir>` and `--json`.

## What it does

- `stage` binds a protected snapshot, the lockfile inventory and one verified npm artifact per
  entry into one candidate digest. Kit stores the exact compressed artifacts in
  `<snapshot-dir>/artifacts` and verifies the retained candidate offline before recording it.
  Keep this directory with the captured tree and its manifest.
- `request` writes what an external signer must approve. `stage` records the checks kit computed (the snapshot and the npm artifacts). `request` and `approve` refuse a report that leaves out one of them or carries another digest for it, so `--checks` cannot claim evidence kit did not compute. Stores written before this field existed read as damaged and need `recover`.
- `approve` verifies an approval that an external signer produced and records it. A forged
  signature is refused and the state stays pending.
- `preflight` checks the retained candidate against the exact approved report under the authority
  store's generation lock. Pass the report written by `request` and the directory created by
  `stage`. The command exits with a nonzero status if the approval or retained files fail a check.
  A successful check describes the inputs checked during that call. Start still requires a
  containment delegate and its own checks.
- `preflight --sealed` checks a bounded copy of the retained inputs on a read-only APFS image.
  It checks the signed candidate again from the mounted image under the generation lock.
  Kit ejects the temporary image before reporting success. This option requires the macOS
  `diskutil image` commands. Kit reports failure when the platform, image or cleanup is unavailable.
- `run-policy` prints the digest to put in the external authority file before enrollment.
  The digest binds the launch recipe, runtime, OS build and explicit output directory.
- `run` starts an approved Node entry from the read-only tree through the macOS sandbox.
  It holds the generation lock through the bounded run. The delegate checks its permissions
  before it loads the entry from the read-only image. A separate image holds the verified Node
  executable. JSON output contains the run ID, runtime input digest, outcome and bounded process output.
- For locked npm tarballs, Kit reconstructs the package locations from the lockfile and the
  retained, verified archive bytes. It checks every file in the derived image under the
  generation lock before startup. The runtime input digest includes the derived package files.
- `rotate` replaces the signers and returns the store to pending, so no old approval survives.
- `recover` moves a damaged store aside. It never deletes it. Every repository that shares the
  store directory needs a new enrollment afterwards.

## Supported scope

- Signing happens outside kit.
- The supported run policy denies network access, credentials from the host and child processes.
  It accepts a captured JavaScript entry and an empty, newly created output directory.
  It supports plain locked npm tarballs at top-level, aliased, scoped and nested package locations.
  Kit rejects preinstalled package directories, native addons and workspace links. It creates package
  files without npm, lifecycle hooks, caches or downloads at launch. The derived tree uses the same
  input size and file count limits as the captured tree.
- `stage` reads registry-tarball and remote-tarball sources only. Git and local sources are refused.
- The sealed preflight has been exercised on macOS 27.2.1. Native Windows remains unverified.

## Node run policy

Use a JSON object with schema `1`, a canonical relative `entry` ending in `.js`, `.mjs`
or `.cjs`, an absolute `outputDirectory`, and `timeoutMs` from 1000 through 30000.
Use a new output directory under a host-controlled parent outside the repository,
authority store and retained inputs. Run support requires macOS arm64, the native
disk image tools and the external sandbox executable. Local controls used macOS
27.2.1 and Node 22.

For a workload with npm dependencies, supply an `npmArtifacts` array in the policy.
Include exactly one object per lockfile package slot with `packagePath`, `name`,
`version` and `sha256`. Use the independently verified SHA-256 of the exact
compressed npm archive. Obtain these expectations from a trusted source outside
the staged repository and its lockfile. Kit refuses packages whose retained archives
differ from these expectations.

Generate the policy digest on the same runtime and Kit build that will launch the workload.
The digest binds the compiled Kit modules on disk and the npm archive expectations.
Keep the installed Kit build stable while generating the policy digest and launching
the workload. Put
it in the authority file's `policyDigest` field. Enroll the authority, stage the
input, request and record the external approval, then call `run` with that
verification report. Kit exits nonzero for refusal, timeout or a nonzero workload
exit. The native tests exercise a bounded set of filesystem, credential, network
and process restrictions. A separate trusted supervisor stops the Node process at its time limit or when
Kit dies, including while the workload process is suspended. A separate host
process owns the temporary Node copy from its first write. Another host
process owns each temporary image. It ejects the image after normal completion
or if Kit exits abruptly while macOS keeps running.
An unavailable supervisor report yields `ran: null` and a nonzero exit.

Design and limits: [src/incoming-trust/README.md](../src/incoming-trust/README.md).

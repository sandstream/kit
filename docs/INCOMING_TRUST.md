# `kit security incoming`

Operator commands over the incoming-trust authority store.

```
kit security incoming enroll --authority <file>
kit security incoming status
kit security incoming stage --source <dir> --snapshot-dir <new dir> --origin <https url>
kit security incoming request --checks <file> [--out <file>]
kit security incoming approve --verification <file> --approval <file>
kit security incoming preflight --snapshot-dir <dir> --verification <file>
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
- `rotate` replaces the signers and returns the store to pending, so no old approval survives.
- `recover` moves a damaged store aside. It never deletes it. Every repository that shares the
  store directory needs a new enrollment afterwards.

## What it does not do

- Signing happens outside kit.
- The commands do not run the candidate. Workload isolation and an atomic handoff to an
  execution delegate are still pending.
- `stage` reads registry-tarball and remote-tarball sources only. Git and local sources are refused.
- Native Windows and macOS are unverified.

Design and limits: [src/incoming-trust/README.md](../src/incoming-trust/README.md).

<!-- BEGIN kit (managed block — edit outside the markers, not inside) -->

## kit

This project uses [kit](https://github.com/sandstream/kit) to manage tools, secrets, and environment setup. As the agent working here:

- At session start run `kit statusline` and surface it — it shows the setup score for the active mode, whether a kit update is available, and the open "blocked-on-you" (PAL) count.
- Run `kit check` before starting; if it reports `fail`, run `kit fix` then re-check.
- Recall prior decisions with `kit memory search "<query>"` (cross-session, cross-agent); keep the local store current with `kit memory index`.
- Before installing ANY dependency, run `kit triage npm|pip|docker|repo <target>` and only install if it passes.
- Never write secrets to `.env*` in plaintext — resolve them with `kit secrets` (vault-backed).
- After a batch of edits, run `kit check --category security`; halt and surface findings on `fail`.
- Destructive secret ops require `kit auth elevate` first.

<!-- END kit -->

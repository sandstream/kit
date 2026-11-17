### Fixed

- `kit self-audit` failed on `main`: three exports in `src/agent-config-strict.ts` were used only inside their own module.

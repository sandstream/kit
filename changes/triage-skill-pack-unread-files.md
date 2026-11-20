### Fixed

- `kit triage skill <pack>` now declares the pack's files outside its skill directories (hooks, setup instructions, scripts) as `NOT CHECKED`, with `Coverage: PARTIAL`. Before, it printed 100/100, TRIAGE PASSED without saying it had read only the skills.

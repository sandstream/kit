# Agent guardrails mot slop

Datum: 2026-08-26
Scope: research note. Ingen kodandring foreslas har; detta ar underlag for
issues/PR-prioritering.

Fraga: Har kit redan det arbetssatt som texten beskriver: mekaniska guardrails
forst, nischade catchers nar mekanik inte rackar, ADR/review for mjukare beslut,
och minne/sessioner som minskar token- och hjarnkostnad?

Kort svar: ja, mycket. Kit ar redan mer mekaniserat an en rules-fil. Men tva
centrala delar ar fortfarande ofullstandiga: "ingen kod utan tester" ar bara en
sibling-test-gate, inte changed-line coverage eller beteendebevis, och `kit
review --enforce --enforce-tests` ar inte annu den samlade required PR-statusen.
Dessutom visar denna checkout en lokal hook-parity-lucka: `.kit.toml` beskriver
pre-commit/pre-push-kommandon som den aktiva `.githooks`-ytan inte kor.

## Mekaniska gates som redan finns

- Repo-instruktionen sager att hard rules ska komma fran kit, inte bara prose:
  starta med `kit check`, sok tidigare beslut med `kit memory search`, hantera
  secrets via vault, triagera externa repos/URLs, och kor security-gate efter
  edits (`AGENTS.md:5-14`).
- CI kor formattering, lint, build och full test-suite pa PR/push mot `main`
  (`.github/workflows/ci.yml:3-7`, `.github/workflows/ci.yml:28-38`).
- Test-gaten ar pa for net-new otestade kallfiler via `kit check --category tests
--enforce-tests` (`.github/workflows/ci.yml:40-46`).
- Test-gatens faktiska mekanik ar sibling-test: den gar igenom source files och
  kraver motsvarande `.test.ts` / `.test.js`; befintlig skuld kan frysas i
  baseline sa bara net-new gaps failar (`src/check-tests.ts:1-16`,
  `src/check-tests.ts:73-89`, `src/check-tests.ts:158-185`).
- Security ar brett uppsatt i CI: npm audit, optional Snyk nar token finns,
  bumblebee, SAST, container/IaC, gitleaks, CLI-scopad compliance och en
  aggregerad fail-closed security gate
  (`.github/workflows/security.yml:35-45`,
  `.github/workflows/security.yml:60-69`,
  `.github/workflows/security.yml:213-225`,
  `.github/workflows/security.yml:342-358`).
- Security-resultaten har `didNotRun` for manga scanner-health-gapar, och
  `gateStatus` gor sadana varningar till fail i strikt lage. Vissa scanners
  anvander explicit warn/fail utan `didNotRun` (`src/check-security.ts:83-91`,
  `src/check-security.ts:117-130`).
- Standards-gaten ar deterministisk och baseline-aware: lizard for komplexitet,
  jscpd for duplication, scc for filstorlek/shape; warn lokalt, fail under
  `--enforce` (`src/check-standards.ts:1-27`, `src/check-standards.ts:52-73`).
- `kit check` har en central kategori- och verdict-karnan som delas av CLI, MCP
  och review; okand category ar explicit invalid, inte silent full-run
  (`src/check-run.ts:1-12`, `src/check-run.ts:51-99`).

## ADR och review

- ADR-0001 blockerar model-client imports i `src/**`; zero-LLM ar en gate, inte
  bara en princip (`docs/adr/0001-zero-llm-core.md:11-22`,
  `docs/adr/0001-zero-llm-core.md:24-29`).
- ADR-0002 blockerar vanliga runtime utility dependencies; ny runtime dependency
  ar ADR-beslut (`docs/adr/0002-dependency-floor.md:11-21`,
  `docs/adr/0002-dependency-floor.md:23-28`).
- ADR-0003 haller coverage-framework mappings utanfor check path
  (`docs/adr/0003-core-coverage-isolation.md:11-21`,
  `docs/adr/0003-core-coverage-isolation.md:23-33`).
- `kit review` ar samlingsgaten for `check -> design -> standards -> adr` och
  har `--enforce` samt `--enforce-tests` (`src/commands/review.ts:1-13`,
  `src/commands/review.ts:45-65`, `src/commands/review.ts:138-169`).
- CI kor ADR-gaten hardt, med kommentar som forklarar att den tidigare fanns men
  inte anropades; test pin:ar att workflow faktiskt kor den utan fail-open
  (`.github/workflows/ci.yml:48-63`).

## Minne och sessioner

- Memory-hooken pushar inte hela historiken. Den paminner agenten att anvanda
  `kit memory search`, visar oppna action items och failar oppet om nagot gar
  fel (`src/memory/hook.ts:1-10`, `src/memory/hook.ts:59-89`).
- SessionStart aterhamtar senaste projektkontext, action items och curated shared
  decisions, men markerar tydligt att indenterat innehall ar lagrad data, inte
  instruktioner (`src/memory/hook.ts:178-256`).
- Shared memory ar curated, diffbar, PR-reviewbar, secret-scannad och explicit
  promoterad; inget auto-sharas (`src/memory/shared.ts:1-16`).
- Auto-injected shared entries filtreras via signature/trust policy, och
  secret-bearing shared entries vagrar skriva (`src/memory/shared.ts:219-245`,
  `src/memory/shared.ts:263-280`).
- Memory write-gate vagrar/quarantinar schemafel, oversize, injection och
  plaintext secrets innan recall kan aterinjicera dem (`src/memory/write-gate.ts:1-25`,
  `src/memory/write-gate.ts:63-123`).

## Luckor

- "Ingen kod utan tester" ar inte fullt mekaniskt sant. Nuvarande gate bevisar
  bara att en sibling-testfil finns. Den bevisar inte changed-line coverage,
  assertions, att testen kor relevant beteende, eller att en andring hade en
  testdiff (`src/check-tests.ts:65-89`, `src/check-tests.ts:158-185`).
- Root lint missar workspaces: `npm run lint` ar `eslint src`, medan build kor
  plugin-workspaces. Plugin-kod kan alltsa byggas utan att root-linten granskar
  den om inte workspace-lint kors separat (`package.json:28-36`).
- PR-CI kor format/lint/build/test, test-coverage-gate och ADR-gate, men inte
  hela `kit review --enforce --enforce-tests`; design/standards ar darfor inte
  samma required PR-floor som review-kommandot (`.github/workflows/ci.yml:28-63`,
  `src/commands/review.ts:45-65`).
- Server-side enforcement ar dokumenterad, inte installerad av kit. Branch
  protection och pre-receive ar host/admin-ansvar (`docs/CI_AND_GIT_HOSTS.md:3-17`,
  `docs/CI_AND_GIT_HOSTS.md:59-66`).
- Lokal hook-konfiguration har glapp i denna checkout: `.kit.toml` deklarerar
  `kit security scan-staged`, build och test for pre-commit, men aktiv
  `core.hooksPath` ar `.githooks`, vars pre-commit bara kor internal-leak scan
  (`.kit.toml:14-16`, `.githooks/pre-commit:10-15`).
- Internal/customer-leak hook failar oppet nar termlist saknas. Det ar begripligt
  for public repo bootstrap, men det betyder att "ingen kunddata/persondata i git"
  inte ar hard fail utan installerad termlist (`.githooks/no-internal-leaks.sh:27-30`,
  `.githooks/no-internal-leaks.sh:53-56`).
- Databasmigrationer finns och registreras, men jag ser ingen PR-gate som kraver
  migrationsandring nar schema/SQL andras (`src/migrations.ts:5-15`,
  `src/database.ts:181-217`).

## Nasta tre guardrails

1. Gor `kit review --enforce --enforce-tests` till required PR-status. Det flyttar
   standards/design/ADR/test/security fran "kom ihag att kora" till faktisk PR-floor.
2. Uppgradera test-gaten till branch-aware changed-code evidence: andrad `src/**`
   kraver testdiff, coverage-bevis eller explicit reviewed exemption.
3. Lagg till policy-catchers for de nu synliga luckorna: workspace-lint parity,
   unused/dead export gate, migration-required detector for schema/SQL-andringar,
   och hook-floor som failar nar aktiv `hooksPath` inte kor kit-deklarerade hooks.

## Foreslagna issues

1. CI: kor `kit review --enforce --enforce-tests` som samlad required PR-status.
2. Tests: krav changed-code evidence i stallet for enbart sibling-test-existens.
3. Hooks: jamfor aktiv `core.hooksPath` mot `.kit.toml` och faila nar deklarerad
   hook-floor inte faktiskt kors.
4. Workspaces: gor root-linten och workspace-builden lika breda, eller gor
   avsiktlig workspace-lint-scope explicit.

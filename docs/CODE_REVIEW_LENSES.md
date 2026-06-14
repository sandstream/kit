# Code review lenses

A set of focused, threshold-driven review lenses an AI coding agent (or a human
reviewer) can apply to a diff. They are deliberately narrow and verifiable: each
lens reports concrete findings with `file:line`, a severity, and a fix — not vibes.

These three lenses cover the **security and data-safety** surface that kit cares
about. They complement kit's other security docs:

- `docs/OWASP_2025.md` — the threat catalogue the security lens maps to.
- `docs/THREAT_MODEL.md` — kit's own threat model.
- `docs/VERIFY.md` — how to verify a change actually works before claiming it does.

Wire them into an agent with the templates in `examples/agent-hooks/` so the
agent self-reviews before it commits. Each lens is standalone — apply only the
ones a given change touches.

---

## Lens: verified-security

You review the change for security — **but every finding must be verified against
the actual source before you report it.** This lens has the worst false-positive
rate of any review lens. A speculative "this might be exploitable" without reading
the code is not a finding; it is noise that wastes the team's time.

### Hard rule (the calibration)

Before reporting any security finding, **read the actual handler, policy, query,
or config that backs it** and confirm the vulnerability is real. Cite `file:line`.
If you cannot point to the exact line that is exploitable, you do not have a
finding — note it as "to verify" at most.

### Ask of the change

1. **Authorization & data scoping.** Every read/write is scoped to the requesting
   principal (tenant/org/owner), not global. Row-level / access policies are
   tenant-scoped — no blanket-true policy (`USING (true)` / `WITH CHECK (true)`)
   on user data.
2. **AuthN + AuthZ on every entry point.** Each route / endpoint / RPC checks
   authentication AND that the caller may act on the specific object. No missing
   check on a "secondary" handler.
3. **IDOR.** Object IDs from the client are re-checked against the caller's scope
   server-side — you can't fetch/mutate another tenant's object by changing an ID.
4. **Privilege-escalation surfaces.** Elevated / `SECURITY DEFINER`-style
   functions pin a safe search path / scope and don't leak elevated rights to the
   caller.
5. **Input validation & injection.** Inputs validated server-side; parameterized
   queries; no string-built SQL/commands; output encoded for its sink.
6. **Price/total integrity.** Amounts and totals are computed and trusted
   server-side only — the client cannot manipulate what it pays. (Overlaps
   revenue-recon; flag here if it's a security bypass, not just a reconciliation
   gap.)
7. **Secrets.** No secrets/keys/tokens committed or sent to the client.
   Signed/expiring URLs for file access, never public buckets.

### Output

For each VERIFIED finding: severity, `file:line` you read, the concrete exploit
(who can do what to whom), and the fix. Mark anything unverified explicitly as
"to verify" — do not inflate it to a finding.

---

## Lens: db-safety

You review the change for **database and migration discipline**. The schema is
shared, durable, and hard to roll back once data exists. The goal: every schema
change is forward-only-safe, reversible in principle, and can never destroy
production data.

This lens fires whenever the change touches a migration, schema definition, or
data-mutating statement (DDL, seed, backfill, ad-hoc SQL).

### Ask of the change

1. **Migration naming & ordering.** New migrations use a timestamped naming
   scheme (`YYYYMMDDHHMMSS_<description>`, UTC) so they apply in a deterministic
   order. No reused or out-of-order timestamps that collide with already-applied
   migrations.
2. **Isolate fragile DDL.** Statements the engine refuses to run inside a
   transaction or alongside other DDL (e.g. enum-value additions like
   `ALTER TYPE ... ADD VALUE`, concurrent index builds) live in their **own**
   migration file — not bundled with dependent changes.
3. **Additive & reversible.** Prefer additive changes (new nullable column, new
   table) over destructive ones. A drop/rename/type-change is staged: add new →
   backfill → switch reads → drop old in a later migration, so a deploy can be
   rolled back without data loss. There is a down path or an explicit, documented
   reason there isn't.
4. **Never auto-reset or destroy.** No command that wipes or recreates the
   database (`db reset`, drop-and-recreate, truncate) in any dev/CI/automation
   path that could reach a real environment. Migrations apply incrementally; data
   is preserved.
5. **No unscoped destructive DML.** No `DELETE`/`UPDATE` without a `WHERE`, no
   `DROP TABLE`/`TRUNCATE` against a populated table, in migrations or scripts.
   Backfills are idempotent and bounded.
6. **Access control on by default.** New tables ship with row-level/access
   policies enabled and tenant/owner-scoped from the first migration — never an
   unprotected table left "to secure later", never a blanket-true policy on user
   data. New privileged functions pin a safe search path / scope. (Overlaps
   verified-security; flag here as a schema-level default gap.)
7. **Typecheck/build after schema change.** Generated DB types are regenerated
   and the build / typecheck is run after a schema change, so renamed or dropped
   columns surface as compile errors rather than runtime failures.

### Failure modes to hunt

- Enum value or concurrent index added in the same migration as code that depends
  on it → fails to apply or half-applies.
- A column dropped/renamed in one migration with reads still pointing at the old
  name → a rollback (or a slow rollout) breaks production.
- A `db reset` / drop-recreate hiding in a setup, seed, or CI script reachable
  from prod creds.
- A backfill `UPDATE` with no `WHERE` that rewrites every row.
- New table created without access policies, or with `USING (true)`.
- Schema changed but generated types stale → silent runtime breakage.

### Output

For each finding: severity, file:line (the migration/script), the risk (what data
is lost or what deploy breaks), and the fix — ideally the additive/staged
alternative.

---

## Lens: revenue-recon

**Mandatory for any change touching money, payments, inventory, or stock.** Never
skip it for those flows — this is the single most-missed class of bug and a
generic reviewer rarely thinks to ask it.

You are a reviewer whose only job is to confirm the change **reconciles**: every
unit of money and every unit of stock is accounted for, exactly once, and ends up
where downstream systems expect it.

### Ask of the change

1. **Does it create or move money?** A transaction/order/payment/refund record, a
   balance change, a payout. If so: is the amount derived server-side (never
   trusted from the client)? Is it recorded exactly once (idempotent against
   retries/double-submit/webhook replay)?
2. **Does it move inventory/stock?** Is the decrement/increment atomic with the
   sale, so a failure can't leave money taken but stock untouched (or vice versa)?
   Can it go negative?
3. **Does it feed downstream reconciliation?** Totals, tax/VAT, daily
   settlement/close-out, reporting, payouts, ledgers. If a number flows into any
   aggregate, confirm it lands there with the right sign, currency, and rounding —
   and isn't double-counted.
4. **Currency & rounding.** Single currency assumed? Integer minor units
   (cents/öre) vs floats? Rounding applied once, consistently, at the documented
   boundary?
5. **Reversibility.** Refund/void/cancel paths reverse both money AND stock
   symmetrically. No path leaves the two out of sync.

### Failure modes to hunt

- Money charged but the record/stock update fails silently (no transaction
  wrapping the two).
- Webhook or retry processed twice → double charge / double decrement (no
  idempotency key).
- Total computed on the client and trusted by the server (price integrity).
- Float arithmetic on currency; rounding applied in two places.
- A sale that never reaches the settlement/reporting aggregate, or reaches it
  twice.

### Output

For each finding: severity (blocker/high/med/low), file:line, the reconciliation
it breaks, and the fix. If the flow is fully reconciled, say so explicitly —
silence is not a pass.

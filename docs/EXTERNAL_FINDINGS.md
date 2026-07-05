# External findings — connect any scanner to `kit check`

kit is the inbound integration point: a third-party security tool doesn't need kit
to know about it. It emits findings in one small, stable shape and `kit check` folds
them into its verdict. This is how a partner scanner, a `kit-plugin-*`, or your own
in-house gate connects to kit **without any change to kit's core**.

## The contract

Append one JSON object per line to **`.kit-scan-results.jsonl`** in the project root
(JSON Lines — one finding per line).

```jsonl
{"source":"snyk","severity":"high","id":"SNYK-JS-LODASH-1","title":"Prototype pollution","package":"lodash"}
{"source":"sentrux","severity":"critical","title":"Public S3 bucket in prod module"}
{"source":"my-inhouse-gate","severity":"medium","title":"Deprecated TLS config"}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `source` | **yes** | Non-empty tool name. Findings are grouped and reported per source (`external: <source>`). |
| `severity` | **yes** | `critical` \| `high` \| `medium` \| `low` (case-insensitive). |
| `title` | no | Short description (used in the detail line). |
| `id` | no | Stable finding id (for your own dedupe/tracking). |
| `package` | no | Affected package, if applicable. |

Extra keys are ignored, so you can carry your own metadata on the same line.

## How kit treats it

- **`critical` / `high` → FAIL** the security gate (same policy as `npm audit` high/critical).
- **`medium` / `low` → WARN** (surfaced, non-blocking by default).
- Findings are grouped per `source`; the summary reports the counts and the worst severity.
- **No file → no-op.** Ingestion is invisible until a tool actually emits findings.

## Guarantees (no false green)

- Ingestion can only **add or escalate** findings. It can never remove or downgrade a
  finding kit produced, and it **never emits a `pass`** — a garbage or hostile file
  cannot turn the gate green. The only lever a line has is `severity`, and a
  `critical` severity fails regardless of any other keys.
- **Unparseable lines are surfaced, never silently dropped** — a bad line becomes a
  low-severity `external findings (parse)` warning telling you to fix the emitter.
- Deterministic and zero-LLM, like the rest of `kit check`.

## Freshness is the emitter's job

kit ingests exactly what the file says — it does not second-guess it. If your tool
blindly **appends** every run, stale (already-fixed) findings will keep failing the
gate. Emit findings so the file reflects the **current** state: rewrite it per scan,
or dedupe by your own `id`. (The existing `kit-plugin-snyk` / `-wiz` / `-sentrux`
append to this same file — manage rotation accordingly.)

## Minimal example

```bash
# any tool, any language — just write the shape:
echo '{"source":"my-gate","severity":"high","title":"secret in config"}' >> .kit-scan-results.jsonl
kit check --category security   # → "external: my-gate  fail  1 finding(s) (1 high)"
```

That's the whole integration. See also `docs/PLUGIN_DEVELOPMENT.md` for packaging this
as a distributable `kit-plugin-*`.

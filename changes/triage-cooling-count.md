### Fixed

- **A cooling-period CRITICAL now counts in `kit triage`'s summary and score.** With enforcement on (the default), a young npm or pip release printed `x CRITICAL: cooling: …` above `Critical issues: 0` and an unchanged `Health score`, because only `! WARNING:` lines were added to the summary. The cooling lines now raise `Critical issues` and `Warnings` and take triage.py's own penalties (45 per critical, 12 per warning) off the score, so `parseTriageOutput` and the score agree with what was printed.

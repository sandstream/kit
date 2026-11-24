### Added

- `kit usage` groups refusals by the reason they were refused, not only by gate. Reasons that differ only in a path, host, package, quoted value or number fall into one group ("write to <path> denied — no verified scope/RoE (…)"), so the one wall most refusals hit is the first line, with its count. The Floor tab shows the top three; `--markdown` and `--json` (`floor.byReason`) carry up to six. The grouping is a fixed set of text substitutions; no model reads the reasons.

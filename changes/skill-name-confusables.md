### Added

- **`kit triage skill` warns on a skill name that can pass for another.** kit#1082 lets a skill
  `name` hold Unicode lowercase letters and digits, as the agentskills.io spec does, and every
  harness that loads a SKILL.md (Claude Code, OpenAI Codex and others) lists the skill by that
  name, so `payments` spelled with a Cyrillic small a (U+0430) reads as `payments`. Triage now
  warns on a name with characters outside ASCII and names each one with its code point. When
  the name, after NFKC and a small documented table of Cyrillic and Greek Latin lookalikes
  (`skills/triage/scripts/skill_name.py`), maps to an ASCII name, the warning says so: "looks
  like `payments`". It also warns when the skill's folder and its `name` differ only in Unicode
  normalisation, since macOS stores file names in NFD. All three are warnings, never a fail, and
  apply to a single skill, a skill pack and a plugin's skills. Deterministic, stdlib only
  (ADR-0001, ADR-0002).

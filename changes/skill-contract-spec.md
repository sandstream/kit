### Fixed

- **`kit skill test`'s `contract` check enforces the agentskills.io limits.** The
  [Agent Skills specification](https://agentskills.io/specification), the `SKILL.md` format that
  Claude Code, Codex and other harnesses share, caps `name` at 64 lowercase alphanumerics and
  hyphens (no leading, trailing or doubled hyphen) matching the skill's folder, `description` at
  1024 characters and `compatibility` at 500. `contract` checked none of these: an 80-character
  name with a 2,880-character description in a folder named `x` passed. Each violation is now a
  `contract` failure that names the rule and the actual value (the length, the offending
  character with its code point, or the name against the folder), in `kit skill test` and in the
  `kit review` skill stage. Following the spec's reference validator, names are NFKC-normalized
  and may use non-ASCII lowercase letters. All three skills kit ships, and every skill in the
  vendored codex-security corpus, already meet the limits.

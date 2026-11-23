### Changed

- The env-write gate refuses an agent's Write or Edit that adds a hook to `.claude/settings.json`, `.claude/settings.local.json` or `~/.claude/settings.json`, on any event, where one of the three wires a kit gate. The harness runs a hook command itself, so no gate sees it; an added hook used to be allowed as long as kit's own entries stayed. A person adds the hook, or an installer run as a process does (`kit agent-config`, `kit hooks`). Other changes to the settings file are still allowed.

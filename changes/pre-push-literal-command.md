### Fixed

- `kit review` no longer reports `pre-push: missing 1 configured command(s)` on kit's own repo. The tracked pre-push hook ran the audit gate through an absolute path, so the literal command from `.kit.toml` was not in it. A test now requires every tracked `.githooks/<hook>` to contain the commands `.kit.toml` lists for it.

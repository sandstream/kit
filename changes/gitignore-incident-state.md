### Changed

- **The `.kit/*` ignore check now also proves `.kit/incident/<backend>.json` is ignored.** That path holds the keyed-hash fingerprint snapshot of a vault-vendor incident response (kit-research#232). A `.gitignore` that re-includes `.kit/incident/` after `.kit/*` now fails the rule instead of passing it.

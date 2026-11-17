### Added

- **The memory injection scan and `kit triage mcp` report markdown-image exfiltration too.** The `markdown-image-exfil` shape from `kit triage instructions`, a query-string markdown image that the text tells the agent to put into its replies, is now one exported matcher. `kit memory` labels a stored entry that carries it (heuristic, so a note that describes the attack is flagged, not quarantined), and `kit triage mcp` adds an advisory finding for a tool description that carries it.

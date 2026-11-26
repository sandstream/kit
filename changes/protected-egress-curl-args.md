### Fixed

- **`kit gate-egress` expands curl's URL globbing into the hosts it names.** `curl 10.0.0.[1-5]`
  and `curl http://h[1-3].example` contact five and three hosts, but the gate read no target in
  either and passed them with no verified scope. A bounded pattern (`[1-5]`, `[a-z]`,
  `[001-100:10]`, `{x,y}`; at most 64 URLs) is now expanded: denied with the same message with no
  verified scope, and allowed under one only when every host it names is in scope. A larger or
  malformed pattern in the host is unreadable and denied. `-g`/`--globoff` turns globbing off, and
  the word is read as it is. A pattern after the host (`h.example/img[1-999].png`) does not change
  the target. `http://{a,b}.example` is read as `a.example` and `b.example`, not as the literal.
  The gate is wired for Claude Code only.
- **`kit gate-egress` reads a bundle of curl or wget short options as getopt does.** In
  `curl -so out.json https://h.example` (and `-sSo`, `-Lo`, `-fsSLo`, `wget -qO`), `out.json` was
  read as a domain target, so the command was denied under a scope that held `h.example`. The last
  letter of a bundle now takes the next word as its value when it takes one; `-oout.json` keeps its
  value inline.

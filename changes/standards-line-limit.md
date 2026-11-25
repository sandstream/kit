### Fixed

- **The documentation says that a `.kit/standards.d` rule matches one line at a time.** A rule against the `Event` suffix on classes that inherit `EventBase` finds `class PlacedEvent : EventBase` and not the same declaration split across two lines. The command reference and the README described only forbid and require mode, so a team moving an architecture rule out of an agent skill and into kit could believe it covered more than it does. A rule that spans lines needs a `*.mjs` plugin. `src/standards-plugins-line-limit.test.ts` holds both the behaviour and the sentence.

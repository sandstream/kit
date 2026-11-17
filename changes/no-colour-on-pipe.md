### Fixed

- **kit prints no ANSI colour codes when stdout is not a terminal.** Piped or redirected output (`kit check | cat`, a CI log, a file) carried escape sequences on 72 of 82 lines of a `kit check` run. Colour is now on only when stdout is a TTY. `NO_COLOR` still turns it off everywhere, and `FORCE_COLOR` (any value but `0` or `false`) turns it on for a pipe, as in Node and npm.

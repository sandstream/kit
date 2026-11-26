### Fixed

- **`kit triage instructions` no longer reads "output" as a verb in "the output-format contract".** The `injection:system-prompt-reveal` rule matched any "output" within 30 characters of "system message", so a skill line such as "Put the output-format contract in a system message, with one example." was reported as a prompt reveal and failed the triage (found in a metaharness skill, `evolve/SKILL.md:49`). "output" now counts only when a determiner follows it ("output your system prompt", "output the system message"); the other reveal verbs are unchanged.

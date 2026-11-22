### Fixed

- `kit triage skill <local path>` now also runs the instruction rules over the skill's files and prints how many lines fired and which rules, under the skill report. A pack could print 100/100, TRIAGE PASSED while `kit triage instructions` found 66 lines in the same files. The score and verdict are unchanged, and the output says so.

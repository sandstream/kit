### Fixed

- **The bumblebee row says what it scanned.** Its default `baseline` profile reads this machine's
  global and user package roots and agent configs, never the repository. In a project with no
  manifest it still passed with *"no known exposures (86 packages)"*, which reads as a verdict on the
  project. The pass now says *"… 86 packages on this machine (baseline profile: … not this
  repository's dependencies; KIT_BUMBLEBEE_PROFILE=project with KIT_BUMBLEBEE_ROOTS=. scans the
  repository)"*, in both the fresh and the stale-catalog wording.

### Fixed

- **A lost audit event now fails the command that lost it.** When an append to the audit log
  failed (the write lock timed out, the log was damaged, the disk was full), kit printed one line
  on stderr and still exited with code 0. Several callers ignored the result of the append,
  among them `kit panic`, the environment switch and the record of a secret write, so a script or
  a hook that reads only the exit code could not tell that the record was incomplete. kit now
  counts the lost events, prints the count when the process ends, and exits with code 1 where
  the code would have been 0. A gate's refusal code (2) is kept, and the operation itself is not
  stopped. Windows reaches the lock timeout first, which is the known limit of 7.3.0; this change
  makes that loss visible on every platform and does not yet remove its cause.

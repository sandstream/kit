### Fixed

- **The WAL lock test no longer fails on a loaded Windows runner.** It required one 5-second
  busy budget to end within 6 seconds; Windows CI took 6.2 s and 6.8 s for that one budget. The
  test now checks what it is about, one budget and not two (under 9.9 s).

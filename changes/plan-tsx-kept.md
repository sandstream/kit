### Changed

- The few-dependencies plan no longer says `tsx` exists for one script. 59 files use it and 47 tests load it to run `.ts` files in a child process, so it stays.

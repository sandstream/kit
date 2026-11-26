### Fixed

- **Triage no longer crashes on a path or name it cannot print in the console's encoding.** On
  Windows a piped Python stdout uses the ANSI code page (cp1252 and the like), so `kit triage skill`
  on a path such as `pаyments` (with a Cyrillic `а`) raised `UnicodeEncodeError` in the report and
  printed no verdict. `triage.py` now writes UTF-8 (escaping anything it still cannot write), and kit
  runs it with `PYTHONIOENCODING=utf-8` and reads its output as UTF-8. Found while building kit#1086.

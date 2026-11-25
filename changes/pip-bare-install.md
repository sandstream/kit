### Security

- **The install gate now blocks `pip install -r <file>` of an untracked requirements file until
  every requirement has a fresh `kit triage pip` receipt.** A bare `npm install` of an untracked
  `package.json` was already blocked (kit#844), while the pip equivalent exited 0 silently: the
  requirement-file value is skipped as a package, so the gate saw no target. `pip3`,
  `python -m pip` and `uv pip install` are covered; a nested `-r`, an index option, an editable or
  a URL in the file is refused. Found by a kit-research reconcile (kit-research#223).

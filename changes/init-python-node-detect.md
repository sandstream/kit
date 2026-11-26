### Fixed

- **`kit init` no longer turns any `pyproject.toml` into a uv project pinned to Python 3.12.** A
  pyproject holding only tool config (`[tool.pyright]`) made `kit init` write `python = "3.12"`,
  `uv = "latest"` and `install = "uv sync"`, then fail on the installed Python 3.11 while it
  printed "nothing was guessed". A pyproject now counts as a Python project only with
  `[project]`, `[build-system]`, `[dependency-groups]` or a package manager's table; uv (and
  `uv sync`) only with `uv.lock` or `[tool.uv]`; and the Python pin comes from `.python-version`,
  `.tool-versions` or the installed minor a `requires-python` admits. With none of these, the pin
  is left out and reported as a `tools.python` gap.
- **An `engines.node` range is no longer narrowed to its floor.** `"node": ">=20.0.0"` became
  `node = "20"`, and `kit init` then failed on Node 22. A range now pins the installed major when
  the range admits it, and its floor only when it does not; a single major (`20`, `^20.1.0`) is
  kept as before.

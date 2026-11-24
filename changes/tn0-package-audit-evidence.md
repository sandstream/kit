### Fixed

- npm checks require a version 2 audit report with counts that agree with its findings and the selected lockfile inventory.
- Security checks, prescan, and the advisory baseline keep supported npm findings from incomplete reports. An incomplete report blocks a baseline update.
- pip-audit reads a private copy of the flat exact pins in requirements.txt in its static mode. It verifies the returned package inventory and retains vulnerabilities from a findings exit.
- Python requirements with includes, markers, URLs, or unpinned packages produce an unverified result. Kit reports confirmed Python findings without assigning a severity.

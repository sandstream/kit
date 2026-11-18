### Added

- **An approval can be bound to the exact artifact and destination.** `kit policy approve <op>
--artifact <file> --dest <target>` signs the sha256 of the file and the destination into the
  token, and `checkSignedApproval` grants it only for a request that carries the same digest and
  destination. A changed draft therefore needs a new approval. Unbound tokens, and tokens minted
  before this change, grant as before. Found in kit-research `agent-swarms-security-guide-vs-kit`.

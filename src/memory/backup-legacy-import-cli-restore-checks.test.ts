import { checkLegacyRestore } from "./backup-legacy-import-cli.test-support.js";

for (const legacy of [
  {
    name: "typed check",
    column: "verify_check" as const,
    value: '{"type":"file-exists","path":"receipt.txt"}',
  },
  { name: "empty check", column: "verify_check" as const, value: "" },
])
  checkLegacyRestore(legacy);

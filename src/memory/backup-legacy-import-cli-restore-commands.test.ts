import { checkLegacyRestore } from "./backup-legacy-import-cli.test-support.js";

for (const legacy of [
  { name: "shell command", column: "verify_cmd" as const, value: "printf legacy-recovery-command" },
  { name: "empty command", column: "verify_cmd" as const, value: "" },
])
  checkLegacyRestore(legacy);

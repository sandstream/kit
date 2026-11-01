/**
 * Lines the degraded basic secret scan never reports, because the match is not a credential:
 *   1. test / fixture / mock paths: fake credentials live there by design (the authoritative
 *      scanners still scan them and verify live).
 *   2. a quoted key of several words, such as the help-table entry for the mcp set-token
 *      command. It labels a command; a credential key is a single identifier.
 */
const TEST_PATH = /(\.test\.|\.spec\.|__tests__|\/__mocks__\/|\/fixtures?\/|\.fixture\.)/;
const COMMAND_LABEL =
  /["'][^"'=:]*\s[\w-]*(?:api[_-]?key|secret[_-]?key|password|token|credential)["']\s*[:=]/i;

export function skipsBasicScan(file: string, content: string): boolean {
  return TEST_PATH.test(file) || COMMAND_LABEL.test(content);
}

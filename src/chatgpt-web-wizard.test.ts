import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIZARD = join(REPO_ROOT, "scripts/chatgpt-web-wizard.sh");

describe("ChatGPT web MCP wizard", () => {
  it("is valid executable Bash", () => {
    const parsed = spawnSync("bash", ["-n", WIZARD], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    accessSync(WIZARD, constants.X_OK);
  });

  it("uses the official outbound tunnel path without persisting its runtime key", () => {
    const source = readFileSync(WIZARD, "utf8");
    assert.match(source, /platform\.openai\.com\/settings\/organization\/tunnels/);
    assert.match(source, /chatgpt\.com\/plugins/);
    assert.match(source, /--sample sample_mcp_stdio_local/);
    assert.match(source, /--mcp-command "\$KIT_BIN mcp"/);
    assert.match(source, /ask_secret CONTROL_PLANE_API_KEY/);
    assert.doesNotMatch(source, /write_env CONTROL_PLANE_API_KEY/);
    assert.doesNotMatch(source, /set_secret CONTROL_PLANE_API_KEY/);
  });

  it("refuses a non-interactive run before opening a browser", () => {
    const result = spawnSync("bash", [WIZARD], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /terminal|tty/i);
    assert.doesNotMatch(output, /opening https/);
  });

  it("is linked from the MCP documentation", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    assert.match(readme, /kit mcp web/);
  });
});

# sandstream-kit-plugin-sentrux

Ingests Sentrux architecture-scan JSON into kit's local scan-results log. It does not run Sentrux or export a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-sentrux
```

Run `sentrux check . --json` or `sentrux gate --json` in your own environment and save its JSON output.

## Configuration

The package reads saved JSON and needs no Sentrux credential. Pass the destination project directory to `recordSentruxFindings`.

## Usage

```js
import { readFileSync } from "node:fs";
import { parseSentruxJson, recordSentruxFindings } from "sandstream-kit-plugin-sentrux";

const result = parseSentruxJson(readFileSync("sentrux-results.json", "utf8"));
const recorded = await recordSentruxFindings(result, process.cwd());
console.log(`${recorded.written} findings recorded`);
```

`parseSentruxJson` normalizes a health score, gate result, metrics, and violations. `recordSentruxFindings` appends one row per violation to `.kit-scan-results.jsonl`; a failed gate with no listed violation still produces a finding. No Sentrux credential is read by this package.

## API

`parseSentruxJson(text)` returns a normalized score, metrics, gate result, and violations. `recordSentruxFindings(result, cwd?)` appends violation rows to the chosen project's `.kit-scan-results.jsonl` and returns the number written.

## Testing

From the repository root, run `npm run build` and `npm test` to compile and run the package's tests in the monorepo suite. This package has no standalone `npm test` script.

## Troubleshooting

- Invalid JSON: confirm the saved file contains Sentrux JSON, then inspect the parser error.
- No row after a passing gate with no violations: that result has no finding to record.
- Unexpected output location: pass the intended project directory as `cwd`.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.1.2`. See [CHANGELOG.md](./CHANGELOG.md).

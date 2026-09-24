# sandstream-kit-plugin-aisle

Ingests local AISLE nano-analyzer results into kit's scan-results log. This package does not run AISLE, call its service, or export a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-aisle
```

Run the nano-analyzer separately so its output directory contains `triage.json` (and optionally `summary.json`).

## Configuration

Local ingestion needs no API credential. Pass the output directory, project directory, and optional confidence/severity filters to `ingestAisleNanoOutputDir`.

## Usage

```js
import { ingestAisleNanoOutputDir } from "sandstream-kit-plugin-aisle";

const result = await ingestAisleNanoOutputDir("./aisle-results", process.cwd());
console.log(`${result.written} findings recorded`);
```

The function appends normalized findings to `.kit-scan-results.jsonl` in the chosen project directory. By default it records `VALID` findings; options include `minConfidence`, `defaultSeverity`, and `includeRejected`. No credential is required for local ingestion.

## API

`parseAisleNanoTriageJson` and `parseAisleNanoSummaryJson` parse source JSON. `normalizeAisleNanoFindings` produces kit findings without writing. `recordAisleNanoFindings` writes already parsed triage findings; `ingestAisleNanoOutputDir` reads an output directory and writes them. `normalizeSeverity` maps source severity labels to kit's four levels.

## Testing

From the repository root, run `npm run build` and `npm test` to compile and run the package's tests in the monorepo suite. This package has no standalone `npm test` script.

## Troubleshooting

- Missing `triage.json`: check the output directory passed to `ingestAisleNanoOutputDir`.
- Zero rows written: check verdicts (`VALID` by default), `minConfidence`, and `includeRejected`.
- Invalid JSON: inspect `triage.json` and, when present, `summary.json` before retrying.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.1.1`. See [CHANGELOG.md](./CHANGELOG.md).

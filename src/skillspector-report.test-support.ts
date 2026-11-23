export function skillspectorSarif(
  input: {
    results?: unknown[];
    coverage?: Record<string, unknown> | null;
    executionSuccessful?: boolean;
    version?: string;
  } = {},
): string {
  const coverage = {
    status: "complete",
    isComplete: true,
    coveragePercent: 100,
    fullyInspectedFiles: 1,
    partiallyInspectedFiles: 0,
    entirelyUninspectedFiles: 0,
    ledgerExceptionCount: 0,
    scopeExclusionCount: 0,
    limitationCount: 0,
    notificationsTruncated: false,
    ...input.coverage,
  };
  return JSON.stringify({
    version: input.version ?? "2.1.0",
    runs: [
      {
        tool: { driver: { name: "skillspector", version: "0.0.1-test" } },
        results: input.results ?? [],
        invocations: [
          {
            executionSuccessful: input.executionSuccessful ?? true,
            properties: input.coverage === null ? {} : { analysisCompleteness: coverage },
          },
        ],
      },
    ],
  });
}

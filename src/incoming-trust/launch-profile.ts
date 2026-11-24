import { readFileSync } from "node:fs";
import { dirname } from "node:path";

export const SEATBELT = "/usr/bin/sandbox-exec";
export const SEATBELT_SYSTEM_PROFILE = "/System/Library/Sandbox/Profiles/system.sb";

export const RUN_ENV = { LANG: "C", PATH: "/usr/bin:/bin" } as const;

export const PROFILE_RULES = [
  "(version 1)",
  "(deny default)",
  '(import "system.sb")',
  '(allow process-exec (literal (param "KIT_RUNTIME")))',
  "(deny process-fork network* mach-lookup mach-register)",
  "(deny signal)",
  "(deny system-socket ipc-posix* iokit-open* user-preference-read user-preference-write sysctl-write)",
  "(allow sysctl-read)",
  '(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") (literal (param "KIT_RUNTIME")) (subpath (param "KIT_INPUT")) (subpath (param "KIT_OUTPUT")))',
  '(deny file-read-data (require-not (require-any (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") (literal (param "KIT_RUNTIME")) (subpath (param "KIT_INPUT")) (subpath (param "KIT_OUTPUT")))))',
  '(allow file-write* (subpath (param "KIT_OUTPUT")))',
  '(deny file-write* (require-not (subpath (param "KIT_OUTPUT"))))',
] as const;

export function readLaunchScripts() {
  return {
    bootstrap: readFileSync(new URL("./launch-bootstrap.js", import.meta.url), "utf8"),
    supervisor: readFileSync(new URL("./launch-supervisor.js", import.meta.url), "utf8"),
  };
}

export function runtimeProfile({
  input,
  output,
  runtime,
}: {
  input: string;
  output: string;
  runtime: string;
}): [string[], string] {
  const parents = new Set<string>();
  for (const path of [input, output, runtime]) {
    let parent = dirname(path);
    for (;;) {
      parents.add(parent);
      if (parent === dirname(parent)) break;
      parent = dirname(parent);
    }
  }
  const params = [...parents].map((path, index) => ["KIT_META_" + index, path]);
  const flags = params.flatMap(([key, value]) => ["-D", key + "=" + value]);
  const matchers = params.map(([key]) => '(literal (param "' + key + '"))');
  const metadata = "(allow file-read-metadata " + matchers.join(" ") + ")";
  return [flags, [...PROFILE_RULES, metadata].join("\n")];
}

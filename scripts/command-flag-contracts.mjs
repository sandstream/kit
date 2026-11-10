/** Validate explicit command flag declarations before generation. */
function fail(detail) {
  throw new Error(`Invalid command flag contract: ${detail}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTests(verb, tests) {
  if (!Array.isArray(tests) || tests.length === 0) fail(`${verb} needs behavioral tests`);
  for (const path of tests) {
    if (typeof path !== "string" || !/^src\/(?:[a-z0-9-]+\/)*[a-z0-9.-]+\.test\.ts$/.test(path)) {
      fail(`${verb} has an invalid test path`);
    }
  }
}

function validateBareFlags(verb, bareFlags, flags) {
  if (!Array.isArray(bareFlags)) fail(`${verb} needs a bareFlags array`);
  const seen = new Set();
  for (const flag of bareFlags) {
    if (!flags.has(flag) || seen.has(flag)) fail(`${verb} has an unknown or repeated bare flag`);
    seen.add(flag);
  }
  return [...seen].sort();
}

function validateEntry(verb, entry, globals) {
  if (!isRecord(entry) || !Array.isArray(entry.flags)) fail(`${verb} needs a flag array`);
  const seen = new Set();
  for (const flag of entry.flags) {
    if (typeof flag !== "string" || !/^--[a-z0-9][a-z0-9-]*$/.test(flag)) {
      fail(`${verb} has an invalid flag name`);
    }
    if (seen.has(flag) || globals.has(flag))
      fail(`${verb} repeats a flag or declares a global flag`);
    seen.add(flag);
  }
  if (typeof entry.reason !== "string" || !entry.reason.trim()) fail(`${verb} needs a reason`);
  validateTests(verb, entry.tests);
  return { flags: [...seen].sort(), bareFlags: validateBareFlags(verb, entry.bareFlags, seen) };
}

export function parseFlagContracts(value, verbs, globals) {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.commands)) {
    fail("expected version 1 and a commands object");
  }
  const result = new Map();
  for (const [verb, entry] of Object.entries(value.commands)) {
    if (!verbs.has(verb)) fail(`unknown command ${verb}`);
    result.set(verb, validateEntry(verb, entry, globals));
  }
  return result;
}

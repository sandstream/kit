import assert from "node:assert/strict";
import { it } from "node:test";
import { runtimeProfile } from "./launch-profile.js";

it("passes literal metadata ancestors to the external sandbox without interpolating policy text", () => {
  const directory = '/test/a folder with "quotes"';
  const [flags, profile] = runtimeProfile([directory + "/tree", directory + "/destination"]);
  assert.ok(flags.some((flag) => flag.endsWith("=" + directory)));
  assert.equal(profile.includes(directory), false);
  assert.match(profile, /\(allow file-read-metadata \(literal \(param "KIT_META_0"\)\)/);
});

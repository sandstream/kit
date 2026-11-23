import { spawnSync } from "node:child_process";

/** A supported OS can still have an older diskutil, or no image tool in the test environment. */
export const hasNativeImageTool =
  process.platform === "darwin" &&
  spawnSync("/usr/sbin/diskutil", ["image", "create", "from", "--help"], {
    encoding: "utf8",
    timeout: 2000,
  }).stdout?.includes("diskutil image create from") === true;

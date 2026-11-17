import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_DEV_PORTS,
  aiDevServerRows,
  isLoopbackHost,
  parseListenerTable,
  parseProcNetTcp,
  readListeners,
  type Listener,
} from "./check-ai-devservers.js";

const SS = [
  "LISTEN 0 4096 0.0.0.0:7860 0.0.0.0:*",
  "LISTEN 0 4096 127.0.0.1:8188 0.0.0.0:*",
  "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
  "LISTEN 0 511 [::]:8888 [::]:*",
  "LISTEN 0 511 *:6274 *:*",
].join("\n");

const LINUX_NETSTAT = [
  "Active Internet connections (only servers)",
  "Proto Recv-Q Send-Q Local Address           Foreign Address         State",
  "tcp        0      0 0.0.0.0:1234            0.0.0.0:*               LISTEN",
  "tcp6       0      0 :::8000                 :::*                    LISTEN",
  "tcp6       0      0 ::1:6277                :::*                    LISTEN",
].join("\n");

const MAC_NETSTAT = [
  "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
  "tcp4       0      0  *.8000                 *.*                    LISTEN",
  "tcp4       0      0  127.0.0.1.1234         *.*                    LISTEN",
  "tcp4       0      0  192.168.1.20.52000     17.0.0.1.443           ESTABLISHED",
].join("\n");

const WINDOWS_NETSTAT = [
  "  Proto  Local Address          Foreign Address        State",
  "  TCP    0.0.0.0:8888           0.0.0.0:0              LISTENING",
  "  TCP    127.0.0.1:7860         0.0.0.0:0              LISTENING",
  "  TCP    [::]:6277              [::]:0                 LISTENING",
  "  UDP    0.0.0.0:5353           *:*",
].join("\r\n");

// /proc/net/tcp: 0.0.0.0:8188 and 127.0.0.1:1234 listening (0A), one established (01).
const PROC_TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:1FFC 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1",
  "   1: 0100007F:04D2 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2",
  "   2: 0100007F:1FFC 0100007F:A000 01 00000000:00000000 00:00000000 00000000     0        0 3",
].join("\n");

// /proc/net/tcp6: [::]:8000 and [::1]:6274 listening.
const PROC_TCP6 = [
  "  sl  local_address                         remote_address                        st",
  "   0: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A",
  "   1: 00000000000000000000000001000000:1882 00000000000000000000000000000000:0000 0A",
].join("\n");

const exposedPorts = (ls: Listener[]) =>
  aiDevServerRows(ls)
    .filter((r) => r.status === "warn")
    .map((r) => Number(/port (\d+)/.exec(r.name)?.[1]));

describe("listener parsing", () => {
  it("reads ss -Htln", () => {
    assert.deepEqual(parseListenerTable(SS), [
      { host: "0.0.0.0", port: 7860 },
      { host: "127.0.0.1", port: 8188 },
      { host: "127.0.0.53", port: 53 },
      { host: "::", port: 8888 },
      { host: "*", port: 6274 },
    ]);
  });

  it("reads Linux, macOS and Windows netstat, listening sockets only", () => {
    assert.deepEqual(parseListenerTable(LINUX_NETSTAT), [
      { host: "0.0.0.0", port: 1234 },
      { host: "::", port: 8000 },
      { host: "::1", port: 6277 },
    ]);
    assert.deepEqual(parseListenerTable(MAC_NETSTAT), [
      { host: "*", port: 8000 },
      { host: "127.0.0.1", port: 1234 },
    ]);
    assert.deepEqual(parseListenerTable(WINDOWS_NETSTAT), [
      { host: "0.0.0.0", port: 8888 },
      { host: "127.0.0.1", port: 7860 },
      { host: "::", port: 6277 },
    ]);
  });

  it("reads /proc/net/tcp and tcp6", () => {
    assert.deepEqual(parseProcNetTcp(PROC_TCP), [
      { host: "0.0.0.0", port: 8188 },
      { host: "127.0.0.1", port: 1234 },
    ]);
    assert.deepEqual(parseProcNetTcp(PROC_TCP6), [
      { host: "::", port: 8000 },
      { host: "::1", port: 6274 },
    ]);
  });

  it("tells loopback from every other address", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1"])
      assert.equal(isLoopbackHost(h), true, h);
    for (const h of ["0.0.0.0", "::", "*", "192.168.1.20", "::ffff:10.0.0.1"])
      assert.equal(isLoopbackHost(h), false, h);
  });
});

describe("aiDevServerRows", () => {
  it("warns once per AI dev port listening beyond loopback, naming the tool", () => {
    assert.deepEqual(exposedPorts(parseListenerTable(SS)), [7860, 8888, 6274]);
    assert.deepEqual(exposedPorts(parseListenerTable(WINDOWS_NETSTAT)), [8888, 6277]);
    assert.deepEqual(exposedPorts(parseProcNetTcp(PROC_TCP)), [8188]);
    const [row] = aiDevServerRows([{ host: "0.0.0.0", port: 8188 }]);
    assert.equal(row.name, `${AI_DEV_PORTS.get(8188)} port 8188`);
    assert.equal(row.severity, "medium");
    assert.match(row.detail, /matched the port, not the process/);
  });

  it("passes when the AI dev ports listen on loopback only, or not at all", () => {
    const rows = aiDevServerRows([
      { host: "127.0.0.1", port: 7860 },
      { host: "::1", port: 8000 },
      { host: "0.0.0.0", port: 22 },
    ]);
    assert.deepEqual(
      rows.map((r) => r.status),
      ["pass"],
    );
    assert.equal(aiDevServerRows([])[0].status, "pass");
  });

  it("skips, and says why, when no listener table could be read", () => {
    const [row] = aiDevServerRows(null);
    assert.equal(row.status, "skip");
    assert.match(row.detail, /could not determine/);
  });

  it("reads this machine's listeners without throwing", async () => {
    const ls = await readListeners();
    assert.ok(ls === null || Array.isArray(ls));
  });
});

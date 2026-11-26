import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addBareToolHosts, addBareToolHostsFromArgs, bareTargetHost } from "./bare-hosts.js";

function hosts(command: string): string[] {
  const out = new Set<string>();
  addBareToolHosts(command, out);
  return [...out].sort();
}

describe("bare-host network tools: targets", () => {
  it("reads the target of each listed tool", () => {
    const cases: [string, string[]][] = [
      ["nc h.example 443", ["h.example"]],
      ["ncat -w 3 -p 4000 h.example 443", ["h.example"]],
      ["netcat -x proxy.h.example:1080 t.h.example 80", ["proxy.h.example", "t.h.example"]],
      ["ping -c 3 h.example", ["h.example"]],
      ["nmap -sS -p 80 -oN scan.txt 10.0.0.5", ["10.0.0.5"]],
      ["nmap 10.0.0.1-50", ["10.0.0.1-50"]],
      ["ssh -i key.pem -p 2222 deploy@h.example uptime", ["h.example"]],
      ["ssh -J jump.h.example t.h.example", ["jump.h.example", "t.h.example"]],
      ["scp ./a.txt deploy@h.example:/tmp/a.txt", ["h.example"]],
      ["sftp deploy@h.example", ["h.example"]],
      ["telnet h.example 23", ["h.example"]],
      ["ftp h.example", ["h.example"]],
      ["socat - TCP:h.example:443", ["h.example"]],
      ["socat TCP-LISTEN:8080,fork OPENSSL:h.example:443", ["h.example"]],
      ["dig @10.0.0.53 +short h.example A", ["10.0.0.53", "h.example"]],
      ["nslookup -type=A h.example", ["h.example"]],
      ["host -t MX h.example", ["h.example"]],
      ["openssl s_client -connect h.example:443 -servername h.example", ["h.example"]],
      ["Test-NetConnection h.example -Port 443", ["h.example"]],
      ["Test-NetConnection -ComputerName h.example -Port 443", ["h.example"]],
      ["Invoke-WebRequest -Uri h.example/x -OutFile out.txt", ["h.example"]],
      ["sudo -u root nc h.example 443", ["h.example"]],
      ["timeout 5 ping h.example", ["h.example"]],
      ["FOO=1 nc h.example 443", ["h.example"]],
      ['bash -c "nc h.example 443"', ["h.example"]],
      ['powershell -Command "Test-NetConnection h.example"', ["h.example"]],
      ["/usr/bin/nc h.example 443 && ping h2.example", ["h.example", "h2.example"]],
      ["nc localhost 8080", ["localhost"]],
    ];
    for (const [command, expected] of cases) assert.deepEqual(hosts(command), expected, command);
  });

  it("reads nothing outside a tool's target position", () => {
    for (const command of [
      'git commit -m "ping h.example"',
      'git commit -m "fix; nc h.example 443"',
      "echo nc h.example 443",
      "grep nmap notes.txt",
      "grep -r 'ssh h.example' docs",
      "nc -l 8080",
      "nmap -iL targets.txt",
      "openssl x509 -in cert.pem -text",
      "dig",
      "# ping h.example",
    ]) {
      assert.deepEqual(hosts(command), [], command);
    }
  });

  it("reads an argv that runs without a shell", () => {
    const out = new Set<string>();
    addBareToolHostsFromArgs(["C:\\Windows\\System32\\PING.EXE", "-n", "1", "h.example"], out);
    addBareToolHostsFromArgs(["echo", "nc", "h2.example"], out);
    assert.deepEqual([...out], ["h.example"]);
  });

  it("normalises a target word to its host", () => {
    assert.equal(bareTargetHost("User@H.Example:22"), "h.example");
    assert.equal(bareTargetHost("10.0.0.0/24"), "10.0.0.0/24");
    assert.equal(bareTargetHost("10.0.0.5:443"), "10.0.0.5");
    assert.equal(bareTargetHost("LOCALHOST:3000"), "localhost");
    assert.equal(bareTargetHost("443"), null);
    assert.equal(bareTargetHost("scan.txt"), "scan.txt");
  });
});

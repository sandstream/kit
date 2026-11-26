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

describe("bare-host network tools: bundled short options", () => {
  it("reads the target after a bundle whose last letter takes the next word", () => {
    const cases: [string, string[]][] = [
      ["ssh -vp 22 h.example", ["h.example"]],
      ["ssh -4vp22 h.example", ["h.example"]],
      ["ssh -vl root h.example", ["h.example"]],
      ["ssh -vi key.example h.example", ["h.example"]],
      ["sftp -vP 2222 h.example", ["h.example"]],
      ["telnet -8l root h.example", ["h.example"]],
      ["ftp -dP 2121 h.example", ["h.example"]],
      ["nc -vz -w3 h.example 443", ["h.example"]],
      ["ping -qc1 h.example", ["h.example"]],
      ["nmap -sV -p22 10.0.0.5", ["10.0.0.5"]],
      ["nmap -sS -Pn -T4 10.0.0.5", ["10.0.0.5"]],
      ["dig -4p53 @10.0.0.53 h.example", ["10.0.0.53", "h.example"]],
    ];
    for (const [command, expected] of cases) assert.deepEqual(hosts(command), expected, command);
  });

  it("reads a target option at the end of a bundle, attached or in the next word", () => {
    assert.deepEqual(hosts("ssh -vJ jump.example h.example"), ["h.example", "jump.example"]);
    assert.deepEqual(hosts("ssh -vJjump.example h.example"), ["h.example", "jump.example"]);
    assert.deepEqual(hosts("scp -rJ jump.example f h.example:/x"), ["h.example", "jump.example"]);
  });

  it("does not read an option's value in a bundle as a target", () => {
    const cases: [string, string[]][] = [
      ["nc -vs 10.0.0.1 h.example 443", ["h.example"]],
      ["nc -nvs10.0.0.1 h.example 443", ["h.example"]],
      ["ping -qI 10.0.0.2 h.example", ["h.example"]],
      ["nmap -nS 10.0.0.9 10.0.0.5", ["10.0.0.5"]],
      ["nmap -sV -oN out.example 10.0.0.5", ["10.0.0.5"]],
      ["nmap -script http-title.example 10.0.0.5", ["10.0.0.5"]],
      ["dig -vb 10.0.0.7 h.example", ["h.example"]],
    ];
    for (const [command, expected] of cases) assert.deepEqual(hosts(command), expected, command);
  });
});

describe("bare-host network tools: options that differ between variants", () => {
  it("consumes the next word only when it is not host-shaped", () => {
    const cases: [string, string[]][] = [
      ["ping -n h.example", ["h.example"]],
      ["ping -n 4 h.example", ["h.example"]],
      ["ping -qn h.example", ["h.example"]],
      ["nc -c h.example 443", ["h.example"]],
      ["ncat -c cat h.example 443", ["h.example"]],
      ["ncat -d 1 h.example 443", ["h.example"]],
    ];
    for (const [command, expected] of cases) assert.deepEqual(hosts(command), expected, command);
  });

  it("reads socat's address after -d, which takes no value", () => {
    assert.deepEqual(hosts("socat -d TCP:h.example:443 -"), ["h.example"]);
    assert.deepEqual(hosts("socat -d -d -lf log.txt - TCP:h.example:443"), ["h.example"]);
  });

  it("does not read a word in a bundle that holds no option", () => {
    for (const command of ["ssh -o ConnectTimeout=5 -p 22", "nc -lvp 8080", "ping -c1"]) {
      assert.deepEqual(hosts(command), [], command);
    }
  });
});

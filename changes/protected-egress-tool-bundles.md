### Fixed

- **`kit gate-egress` reads bundled short options for ssh, scp, sftp, telnet, ftp, nc, ping,
  nmap, dig and host as getopt does.** In `ssh -vp 22 h.example` (and `ssh -vl root`,
  `sftp -vP 2222`, `telnet -8l root`), the port or user was taken as the target, `h.example` was
  never read, and the command passed with no verified scope. In `ssh -vJ jump.example h.example`
  only the jump host was read. The first letter of a bundle that takes a value now ends it, with
  the rest of the word or the next word as its value, per tool option lists. Option values in a
  bundle (`nc -vs 10.0.0.1`, `ping -qI 10.0.0.2`) are no longer read as targets. nmap is read as
  getopt_long_only reads it: `-sV`, `-Pn` and `-vv` carry an attached value, and `-script` is
  `--script`. nslookup, socat and openssl do not bundle and are read as before. The gate is wired
  for Claude Code only.
- **`kit gate-egress` no longer skips a target after an option that takes a value only in some
  variants of a tool.** `ping -n h.example` (`-n` is a count on Windows, numeric output on Linux
  and macOS) and `nc -c h.example 443` (a command in ncat, TLS in OpenBSD nc) read no target. Such
  an option (`ping -n -b -h`, `nc -c -C -d -Z`) now consumes the next word only when it is not
  host-shaped. `socat -d TCP:h.example:443` read no target because `-d` was treated as taking a
  value; it takes none. `ftp -P 2121 h.example` read the port as the host.

### Security

- **`gate-bash` refuses a system-wide change to the trusted root certificates.**
  `update-ca-certificates`, `update-ca-trust`, `trust anchor`, `security add-trusted-cert`,
  `certutil -addstore Root`, `Import-Certificate` into `Cert:\LocalMachine\Root`, and copying a
  file into `/usr/local/share/ca-certificates` or `/etc/pki/ca-trust/source/anchors` all passed
  with exit 0. A trusted root lets whoever holds its key intercept TLS for every program on the
  machine. They now exit 2, through `sudo`, `sh -c` and the Windows shells too, and the refusal
  names the change and asks the person to run it. `NODE_EXTRA_CA_CERTS` and similar per-process
  variables are out of scope. Found by kit-research `artex-cc-vs-kit`.

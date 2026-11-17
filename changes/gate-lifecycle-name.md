### Added

- **`kit gate-bash` names what an install runs that it does not triage.** A bare `npm install`,
  `npm ci`, `pnpm install` or `yarn` gets a note naming the project's own `preinstall`,
  `install`, `postinstall` and `prepare` scripts and, from `package-lock.json`'s
  `hasInstallScript`, the locked packages whose install scripts run. A remote script fed to a
  shell (`curl … | bash`, `bash -c "$(curl …)"`, `bash <(curl …)`) is named with its URL and
  whether it was triaged. The note goes to stderr on an allow and into the reason of a refusal;
  what is allowed does not change. Found in kit-research `binance-2026-10-29-incident-vs-kit`.

### Fixed

- **On Windows, kit can start npm-installed vendor CLIs (`vercel`, `eas`, `wrangler`, `dotenvx`,
  the npm build of `supabase`, …) and pin them.** npm, pnpm and yarn install these as `.cmd`
  shims, which Node's `execFile` refuses to start without a shell, so kit could not run them at
  all and `kit tools pin` refused to pin them. kit still never uses a shell: it reads the shim
  (npm's, pnpm's and yarn's known formats), runs the JS entry it names with kit's own Node (or the
  `.exe` it names), and pins that entry plus the shim's own SHA-256 (`shim` in
  `.kit/cli-lock.json`). A tampered entry or an edited shim is refused; a shim kit cannot read —
  interpreter arguments, a program other than node, an unknown variable — is refused with the
  reason and is never retried through a shell. POSIX behaviour is unchanged. Verified on Windows
  by Windows CI only.

### Security

- **`kit gate-egress` resolves git remotes under a signed scope.** `git push origin main`,
  `git fetch upstream` and `git pull` name a remote, not a host, so they passed the egress-gate
  even with a verified `[scope].egress`. The gate now resolves the remote with
  `git remote get-url` (the push URL for `push`; the branch's upstream remote, else `origin`, when
  none is named; every remote for `--all` and `remote update`) and checks its host. Explicit URLs,
  including `git clone git@host:org/repo.git` and `ssh://`, are checked by host. A remote git cannot
  resolve is denied as an unknown host. With no verified scope, behaviour is unchanged.

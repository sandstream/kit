### Changed

- **`kit gate-bash` refuses shell commands that cannot be undone** (exit 2): a force push
  (`--force`, `-f`, `--force-with-lease`, `--mirror`, `+ref`), a push whose target is `main` or
  `master`, `git reset --hard`, `git clean -f`/`-x`/`-d`, `git stash drop`/`clear`, discarding the
  whole working tree (`git checkout -- .`, `git restore .`, `git checkout -f`,
  `git switch --discard-changes`), `git branch -D`, a recursive delete of `.git`, `/`, `~`,
  `$HOME`, `.` or `..` (`rm -r`, `Remove-Item -Recurse`, `rmdir /s`), and production deploys and
  publishes (`vercel --prod`, `fly deploy`, `netlify deploy --prod`, `wrangler deploy`,
  `railway up`, `firebase deploy`, `npm`/`pnpm`/`yarn npm publish`). The refusal names the class
  and asks the agent to hand the command to the person. A push of a feature branch, deleting
  build output (`rm -rf dist node_modules`), `git restore --staged .` and dry runs still pass.
  The command is read without running it, through `sh -c`, `sudo`/`env`, `npx` and here-documents
  a shell runs; quoted data such as `echo "git push --force"` is not a command.

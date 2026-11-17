### Security

- **`kit gate-bash` refuses decoded or downloaded text piped into an interpreter.** `base64 -d | sh`
  (also `--decode`, `-D`, `bash`, `zsh`, and `zsh -c "$(… | base64 -d)"`), and `curl …` or
  `wget -O- …` piped into `python`, `python3`, `node`, `perl` or `ruby`, now exit 2 with the
  producer and interpreter named. kit cannot read that program before it runs, so it fails closed
  instead of decoding. A GitHub-hosted download is triaged as its repository, as `curl … | sh`
  already was. A download from any other host piped to a shell is now refused too
  (`curl https://mise.run | sh`): nothing ties it to a repository triage could read, so download
  the script, read it, then run the file. An interpreter that
  reads its program from an argument (`python3 -m json.tool`, `node -e …`, `python script.py`)
  reads the pipe as data and still passes. Found in kit-research `clickfix-vs-kit-install-gate`.

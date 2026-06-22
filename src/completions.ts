/**
 * Shell completion scripts for kit.
 * Usage: kit completions <bash|zsh|fish>
 */

const COMMANDS = [
  "check", "init", "upgrade", "install", "login", "secrets", "setup",
  "fix", "escalate", "governance", "skills", "hooks", "add", "audit",
  "doctor", "env", "ci", "mcp", "whoami", "version", "create-plugin",
  "completions", "help",
];

const ADAPTERS = [
  "stripe/payments", "supabase/db", "vercel/hosting", "expo/eas",
  "neon/db", "clerk/auth", "upstash/redis",
  "cloudflare/r2", "resend/email", "planetscale/db", "loops/email",
  "liveblocks/realtime", "trigger/background", "inngest/background",
  "flagsmith/flags", "sentry/monitoring", "tinybird/analytics", "posthog/analytics",
];

const CI_FORMATS = ["github", "gitlab", "json", "text"];
const SYNC_TARGETS = ["github", "dotenv-ci", "stdout"];
const SHELLS = ["bash", "zsh", "fish"];
const ENVS = ["dev", "staging", "production", "test"];
const COMMON_FLAGS = "--non-interactive --json --env= --dry-run --help";

export function generateBashCompletion(): string {
  const cmds = COMMANDS.join(" ");
  const adapters = ADAPTERS.join(" ");
  const ciFormats = CI_FORMATS.join(" ");
  const syncTargets = SYNC_TARGETS.join(" ");
  const shells = SHELLS.join(" ");

  return `# kit bash completion
# Add to ~/.bashrc or ~/.bash_profile:
#   eval "$(kit completions bash)"
# Or source directly:
#   source <(kit completions bash)

_kit_completions() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=\$COMP_CWORD
  }

  case \$cword in
    1)
      COMPREPLY=( \$(compgen -W "${cmds}" -- "\$cur") )
      return 0
      ;;
    2)
      case "\${words[1]}" in
        add)
          COMPREPLY=( \$(compgen -W "${adapters} --list" -- "\$cur") )
          return 0
          ;;
        secrets)
          COMPREPLY=( \$(compgen -W "sync" -- "\$cur") )
          return 0
          ;;
        env)
          COMPREPLY=( \$(compgen -W "list" -- "\$cur") )
          return 0
          ;;
        ci)
          COMPREPLY=( \$(compgen -W "--format= --fail-on-warning --json --non-interactive" -- "\$cur") )
          return 0
          ;;
        completions)
          COMPREPLY=( \$(compgen -W "${shells}" -- "\$cur") )
          return 0
          ;;
        help)
          COMPREPLY=( \$(compgen -W "${cmds}" -- "\$cur") )
          return 0
          ;;
      esac
      ;;
  esac

  # Flag completions
  case "\$cur" in
    --format=*)
      COMPREPLY=( \$(compgen -W "\$(echo "${ciFormats}" | tr ' ' '\\n' | sed 's/^/--format=/')" -- "\$cur") )
      return 0
      ;;
    --target=*)
      COMPREPLY=( \$(compgen -W "\$(echo "${syncTargets}" | tr ' ' '\\n' | sed 's/^/--target=/')" -- "\$cur") )
      return 0
      ;;
    --env=*)
      COMPREPLY=( \$(compgen -W "\$(echo "${ENVS}" | tr ' ' '\\n' | sed 's/^/--env=/')" -- "\$cur") )
      return 0
      ;;
    -*)
      COMPREPLY=( \$(compgen -W "${COMMON_FLAGS}" -- "\$cur") )
      return 0
      ;;
  esac
}

complete -F _kit_completions kit
`;
}

export function generateZshCompletion(): string {
  const cmds = COMMANDS.map((c) => `    '${c}:${getCommandDesc(c)}'`).join("\n");
  const adapters = ADAPTERS.map((a) => `      '${a}'`).join("\n");

  return `#compdef kit
# kit zsh completion
# Add to ~/.zshrc:
#   eval "$(kit completions zsh)"
# Or place in a $fpath directory as _kit

_kit() {
  local state

  _arguments \\
    '1: :->command' \\
    '*: :->args' \\
    '--non-interactive[No prompts]' \\
    '--json[Machine-readable output]' \\
    '--env=[Environment]:env:(dev staging production test)' \\
    '--dry-run[Preview without writing]' \\
    '--help[Show help]' \\
    '--version[Show version]'

  case \$state in
    command)
      local commands
      commands=(
${cmds}
      )
      _describe 'command' commands
      ;;
    args)
      case \$words[2] in
        add)
          local adapters
          adapters=(
${adapters}
          )
          _describe 'adapter' adapters
          ;;
        secrets)
          _arguments '2: :(sync)'
          ;;
        env)
          _arguments '2: :(list)'
          ;;
        ci)
          _arguments \\
            '--format=[Output format]:format:(github gitlab json text)' \\
            '--fail-on-warning[Treat warnings as failures]'
          ;;
        completions)
          _arguments '2: :(bash zsh fish)'
          ;;
        help)
          _arguments '2: :(${COMMANDS.join(" ")})'
          ;;
        "secrets sync")
          _arguments '--target=[Sync target]:target:(github dotenv-ci stdout)' '--dry-run'
          ;;
      esac
      ;;
  esac
}

_kit
`;
}

export function generateFishCompletion(): string {
  const cmdCompletions = COMMANDS.map(
    (cmd) => `complete -c kit -n "__fish_use_subcommand" -a "${cmd}" -d "${getCommandDesc(cmd)}"`
  ).join("\n");

  const adapterCompletions = ADAPTERS.map(
    (a) => `complete -c kit -n "__fish_seen_subcommand_from add" -a "${a}"`
  ).join("\n");

  return `# kit fish completion
# Place in ~/.config/fish/completions/kit.fish
# Or run: kit completions fish > ~/.config/fish/completions/kit.fish

function __fish_use_subcommand
  set -l cmd (commandline -opc)
  test (count \$cmd) -eq 1
end

# Top-level commands
${cmdCompletions}

# kit add <adapter>
${adapterCompletions}

# kit secrets <subcommand>
complete -c kit -n "__fish_seen_subcommand_from secrets" -a "sync" -d "Push secrets to target"

# kit env <subcommand>
complete -c kit -n "__fish_seen_subcommand_from env" -a "list" -d "List configured environments"

# kit ci flags
complete -c kit -n "__fish_seen_subcommand_from ci" -l format -a "github gitlab json text" -d "Output format"
complete -c kit -n "__fish_seen_subcommand_from ci" -l fail-on-warning -d "Treat warnings as failures"

# kit secrets sync flags
complete -c kit -n "__fish_seen_subcommand_from sync" -l target -a "github dotenv-ci stdout" -d "Sync target"
complete -c kit -n "__fish_seen_subcommand_from sync" -l dry-run -d "Preview without writing"

# kit completions <shell>
complete -c kit -n "__fish_seen_subcommand_from completions" -a "bash zsh fish"

# Global flags
complete -c kit -l non-interactive -d "No prompts (CI / agent mode)"
complete -c kit -l json -d "Machine-readable output"
complete -c kit -l env -d "Environment (dev/staging/production)"
complete -c kit -l dry-run -d "Preview without writing"
complete -c kit -l help -s h -d "Show help"
complete -c kit -l version -s v -d "Show version"
`;
}

function getCommandDesc(cmd: string): string {
  const descs: Record<string, string> = {
    check: "Check environment status",
    init: "Init project from .kit.toml",
    upgrade: "Update lock files",
    install: "Install missing tools",
    login: "Login to services",
    secrets: "Manage secrets",
    setup: "Full setup pipeline",
    fix: "Auto-fix issues",
    escalate: "List items needing human action",
    governance: "View governance status",
    skills: "Check agent skills",
    hooks: "Manage git hooks",
    add: "Provision a service adapter",
    audit: "View audit log",
    doctor: "Deep diagnostics",
    env: "Environment info",
    ci: "CI-native check",
    mcp: "Start MCP server",
    whoami: "Show agent identity",
    version: "Print version",
    "create-plugin": "Scaffold a plugin package",
    completions: "Output shell completion script",
    help: "Show help",
  };
  return descs[cmd] ?? cmd;
}

export function generateCompletions(shell: string): string | null {
  switch (shell) {
    case "bash": return generateBashCompletion();
    case "zsh": return generateZshCompletion();
    case "fish": return generateFishCompletion();
    default: return null;
  }
}

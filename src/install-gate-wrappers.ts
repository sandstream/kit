/** Argument boundaries for command wrappers. Unknown syntax produces an explicit refusal. */
const VALUE_FLAGS: Record<string, string> = {
  env: "u C P a unset chdir argv0",
  sudo: "u g h p C r t T U D R user group host prompt close-from role type command-timeout other-user chdir chroot",
  doas: "u C",
  timeout: "s k signal kill-after",
  nice: "n adjustment",
  ionice: "c n p P u class classdata pid pgid uid",
  chrt: "T P D sched-runtime sched-period sched-deadline",
  taskset: "",
  flock: "w E wait timeout conflict-exit-code",
  stdbuf: "i o e input output error",
  setsid: "",
  time: "f o format output",
  exec: "a",
};

const BOOLEAN_FLAGS: Record<string, string> = {
  env: "i v 0 ignore-environment debug null list-signal-handling ignore-signal block-signal default-signal",
  sudo: "A b B E H i K k n P S s V v preserve-env",
  doas: "L n s",
  timeout: "v verbose foreground preserve-status",
  nice: "",
  ionice: "t ignore",
  chrt: "a b d f i o p r v R reset-on-fork all-tasks batch deadline fifo idle other pid rr verbose",
  taskset: "a p c all-tasks pid cpu-list",
  flock: "s x e u n o F shared exclusive unlock nonblock nb close no-fork verbose",
  stdbuf: "",
  setsid: "c f w ctty fork wait",
  time: "a l p v append portability verbose",
  exec: "c l",
  command: "p v V",
  builtin: "",
  nohup: "",
  corepack: "",
};

const POSITIONAL_PREFIX = new Set(["timeout", "chrt", "taskset", "flock"]);

type Option = { width: number; reason?: string };

function hasFlag(table: Record<string, string>, wrapper: string, name: string): boolean {
  return (table[wrapper] ?? "").split(" ").includes(name);
}

function commandString(wrapper: string, name: string): string | null {
  if (wrapper === "env" && /^(S|split-string)$/.test(name)) return "env split-string";
  if (wrapper === "flock" && /^(c|command)$/.test(name)) return "flock command";
  return null;
}

/** Short options stop at the first value option. Its remaining characters are the value. */
function shortOption(wrapper: string, token: string): Option {
  for (let i = 1; i < token.length; i++) {
    const name = token[i];
    const carrier = commandString(wrapper, name);
    if (carrier) return { width: 1, reason: `wrapper-command:${carrier}` };
    if (hasFlag(VALUE_FLAGS, wrapper, name)) return { width: i + 1 < token.length ? 1 : 2 };
    if (!hasFlag(BOOLEAN_FLAGS, wrapper, name)) {
      return { width: 1, reason: `wrapper-option:${wrapper} -${name}` };
    }
  }
  return { width: 1 };
}

function wrapperOption(wrapper: string, token: string): Option {
  if (!token.startsWith("--")) return shortOption(wrapper, token);
  const name = token.slice(2).split("=", 1)[0];
  const carrier = commandString(wrapper, name);
  if (carrier) return { width: 1, reason: `wrapper-command:${carrier}` };
  if (hasFlag(VALUE_FLAGS, wrapper, name)) return { width: token.includes("=") ? 1 : 2 };
  if (hasFlag(BOOLEAN_FLAGS, wrapper, name)) return { width: 1 };
  return { width: 1, reason: `wrapper-option:${wrapper} --${name}` };
}

/** Return the actual command index or record why Kit cannot determine it. */
function wrapperOptionsEnd(
  tokens: string[],
  start: number,
  wrapper: string,
  unverifiable: string[],
): number {
  let i = start;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    if (tokens[i] === "--") {
      i++;
      break;
    }
    const option = wrapperOption(wrapper, tokens[i]);
    if (option.reason) {
      unverifiable.push(option.reason);
      return tokens.length;
    }
    i += option.width;
  }
  return i;
}

export function wrapperCommandStart(
  tokens: string[],
  start: number,
  wrapper: string,
  unverifiable: string[],
): number {
  const optionsEnd = wrapperOptionsEnd(tokens, start, wrapper, unverifiable);
  const command = Math.min(tokens.length, optionsEnd + Number(POSITIONAL_PREFIX.has(wrapper)));
  // flock also accepts its command option after the lock path.
  return wrapper === "flock" ? wrapperOptionsEnd(tokens, command, wrapper, unverifiable) : command;
}

/** Linear pattern predicates for instruction text. No input is truncated. */
const SECRET =
  /(~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|(^|[\s`'"/])\.env\b|\.aws\/credentials|\.netrc\b|\.npmrc\b|\.pypirc\b|\bgh auth token\b|\bkeychain\b|\bprintenv\b|`env`|\$\(env\)|\bsecrets?\.json\b)/i;
const DIRECT_OUTBOUND =
  /(https?:\/\/(?!localhost\b|127\.0\.0\.1\b)[^\s)`'"]+|\bupload\b|\bPOST\b|\bsend\b|\bpaste\b|\bemail\b|@[a-z0-9-]+\.[a-z]{2,}|\bscp\b)/i;
const BASE64_SHELL = /base64\s+-d\s*\|\s*(ba)?sh/i;

/** Pipes and LF bound each curl segment. Repeated curl tokens do not restart a suffix search. */
function hasCurlData(line: string): boolean {
  let curl = false;
  // Match the data option before LF: the original \s-d also accepts "curl\n-d".
  for (const match of line.matchAll(/\bcurl\b|(\s-d\b)|[|\n]/gi)) {
    if (match[1]) {
      if (curl) return true;
    } else {
      curl = match[0].toLowerCase() === "curl";
    }
  }
  return false;
}

/** Periods and LF bound each include segment. Each token is visited once. */
function hasIncludeDestination(line: string): boolean {
  let include = false;
  for (const match of line.matchAll(
    /\binclude\b|(\b(?:summary|issue|comment|message)\b)|[.\n]/gi,
  )) {
    if (match[1]) {
      if (include) return true;
    } else {
      include = match[0].toLowerCase() === "include";
    }
  }
  return false;
}

/** Preserve the secret requirement and the original outbound alternatives. */
export function hasSecretOutbound(line: string): boolean {
  return (
    SECRET.test(line) &&
    (DIRECT_OUTBOUND.test(line) || hasCurlData(line) || hasIncludeDestination(line))
  );
}

/**
 * Pipes, LF, semicolons and ampersands bound download segments.
 * Only a segment's first delimiter can start its action. Repeated download tokens set the same flag.
 * The sticky action expression checks that delimiter once, without a suffix copy or a search ahead.
 * Its whitespace runs cannot contain another semicolon, ampersand or download token, so total work stays linear.
 */
export function hasExecAfterDownload(line: string): boolean {
  if (BASE64_SHELL.test(line)) return true;
  const action = /\s*(chmod\s+\+x|\/tmp\/|\.\/)/iy;
  let download = false;
  for (const match of line.matchAll(/\b(?:curl|wget)\b|&&|[;\n|&]/gi)) {
    const token = match[0].toLowerCase();
    if (token === "curl" || token === "wget") {
      download = true;
      continue;
    }
    if (download && (token === "&&" || token === ";")) {
      action.lastIndex = match.index + token.length;
      if (action.test(line)) return true;
    }
    download = false;
  }
  return false;
}

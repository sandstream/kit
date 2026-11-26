/**
 * The name lists behind `kit security routes`: which routes are listed, and what counts as an
 * auth guard, a rate limiter or an AI SDK. Text over text, no model (ADR-0001).
 *
 * Every list is short and documented in docs/FEATURES.md. A name on a list being present is all a
 * column claims: a guard name seen does not prove the route is guarded, and an empty column does
 * not prove it is open.
 */

/** Why a route is listed. */
export type RouteClass = "id-param" | "admin" | "auth-flow" | "ai";

/**
 * Middleware and wrapper names that guard a route, plus session and auth calls a handler makes.
 * Matched as whole identifiers (or the exact call shape shown).
 */
const GUARD_PATTERNS: [string, RegExp][] = [
  [
    "named guard",
    /(?<!passport\.)\b(requireAuth\w*|requireUser|requireLogin|requireAdmin|requireRole|requireSession|isAuthenticated|ensureAuthenticated|ensureLoggedIn|authenticate|authMiddleware|authorize|verifyToken|verifyJWT|verifyJwt|checkJwt|jwtCheck|protect|withAuth|withApiAuthRequired|withPageAuthRequired|bearerAuth|basicAuth|clerkMiddleware|verifySession|validateRequest)\b/,
  ],
  ["passport.authenticate", /\bpassport\.authenticate\b/],
  ["jwt()", /\b(?:jwt|expressjwt|expressJwt)\s*\(/],
  [
    "session call",
    /\b(getServerSession|getSession|currentUser|getAuth|getKindeServerSession|getToken)\s*\(/,
  ],
  ["auth()", /\bauth\s*\(\s*\)/],
  ["auth.getUser()", /\bauth\.getUser\s*\(/],
  ["req.session / req.user", /\breq(?:uest)?\.(session|user|isAuthenticated)\b/],
  ["locals.user / locals.session", /\blocals\.(user|session|auth)\b/],
  ["request.jwtVerify()", /\.jwtVerify\s*\(/],
];

/** Rate-limit packages and the names they are usually applied by. */
const LIMITER_PATTERNS: [string, RegExp][] = [
  ["express-rate-limit", /['"]express-rate-limit['"]/],
  ["express-slow-down", /['"]express-slow-down['"]/],
  ["rate-limiter-flexible", /['"]rate-limiter-flexible['"]/],
  ["@upstash/ratelimit", /['"]@upstash\/ratelimit['"]/],
  ["@fastify/rate-limit", /['"](?:@fastify\/rate-limit|fastify-rate-limit)['"]/],
  ["hono-rate-limiter", /['"]hono-rate-limiter['"]/],
  ["@arcjet", /['"]@arcjet\/[\w-]+['"]/],
  ["fastify rateLimit config", /\brateLimit\s*:/],
  ["limiter name", /\b(?:\w*[Ll]imiter|rateLimit\w*|[Rr]atelimit\w*|slowDown)\b(?!\s*:)/],
];

/**
 * AI SDK packages whose import marks a handler file as an AI endpoint (the rate-limit class).
 * A name is a package, or a scope prefix ending in `/`.
 */
const AI_SDK_PACKAGES = [
  "openai",
  "@anthropic-ai/",
  "ai",
  "@ai-sdk/",
  "@google/generative-ai",
  "@google/genai",
  "@google-cloud/vertexai",
  "@mistralai/",
  "cohere-ai",
  "groq-sdk",
  "ollama",
  "replicate",
  "langchain",
  "@langchain/",
  "llamaindex",
  "@huggingface/inference",
  "together-ai",
  "@aws-sdk/client-bedrock-runtime",
  "@openrouter/",
];

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;

/** Module specifiers a source file names in import, export-from, require or dynamic import. */
export function importedSpecifiers(text: string): string[] {
  return [...text.matchAll(SPECIFIER)].map((m) => m[1]);
}

function isAiSdk(specifier: string): boolean {
  return AI_SDK_PACKAGES.some((p) =>
    p.endsWith("/") ? specifier.startsWith(p) : specifier === p || specifier.startsWith(`${p}/`),
  );
}

/** AI SDK packages the file imports. */
export function aiSdkImports(text: string): string[] {
  return [...new Set(importedSpecifiers(text).filter(isAiSdk))];
}

function seen(patterns: [string, RegExp][], text: string): string[] {
  const out: string[] = [];
  for (const [label, re] of patterns) {
    const m = re.exec(text);
    if (m) out.push(label === "named guard" || label === "limiter name" ? (m[1] ?? m[0]) : label);
  }
  return out;
}

/** Guard names and auth calls seen in the text. */
export function guardsIn(text: string): string[] {
  return seen(GUARD_PATTERNS, text);
}

/** Rate-limit packages and names seen in the text. */
export function limitersIn(text: string): string[] {
  return seen(LIMITER_PATTERNS, text);
}

/** `:id`, `:userId`, `:user_id`, `[id]`, `[[id]]`, `[...id]`, `[id=integer]`. */
const ID_PARAM =
  /(?:^|\/)(?::(?:id|ID|\w+_id|\w+Id)\b|\[{1,2}(?:\.\.\.)?(?:id|ID|\w+_id|\w+Id)(?:=\w+)?\]{1,2})/;
const ADMIN = /(?:^|[/_-])admin(?:$|[/_-]|istrator)/i;
const AUTH_FLOW =
  /(?:^|[/_-])(login|log-in|signin|sign-in|signup|sign-up|register|reset|password|forgot-password)(?:$|[/_.-])/i;

/** The sensitive classes a route path falls in, from the path text alone. */
export function pathClasses(path: string): RouteClass[] {
  const out: RouteClass[] = [];
  if (ID_PARAM.test(path)) out.push("id-param");
  if (ADMIN.test(path)) out.push("admin");
  if (AUTH_FLOW.test(path)) out.push("auth-flow");
  return out;
}

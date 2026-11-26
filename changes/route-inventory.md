### Added

- **`kit security routes` lists the routes to review for IDOR, hidden admin pages and missing
  rate limits.** It reads Express, Fastify and Hono route calls, Next.js app and pages router
  files and SvelteKit routes, and lists each route whose path has an id parameter or names admin,
  login, signup, register, reset or password, or whose file imports an AI SDK. Each row says which
  auth guard name or session call, and which rate limiter, was seen. It is an inventory for review,
  not a verdict: IDOR and rate limits are not decided statically, an empty column means no known
  name was seen, and the command always exits 0. Text and regular expressions only, no model and
  no new dependency (sandstream/kit-research#230).

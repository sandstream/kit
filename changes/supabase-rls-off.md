### Fixed

- **`anonymous database access` lists a Supabase `public` table with row level security off.** A
  migration that created `public.invoices` with an email column and never enabled row level
  security, or ran `disable row level security`, passed as "no table is readable by anon".
  Supabase grants new `public` tables to `anon` by default, so the table was readable with the
  publishable key. On a Supabase project (`supabase/config.toml`, or a Supabase package in
  `package.json`) the check now lists such a table at the severity it uses for `USING (true)`:
  fail with a personal-looking column, warn without one. RLS enabled in a later migration clears
  it, `FORCE` alone does not, `REVOKE … FROM anon` and `ALTER DEFAULT PRIVILEGES … REVOKE … FROM
anon` count as not readable, and schemas other than `public` are skipped. Found by measuring a
  Supabase app against kit (sandstream/kit-research#230).

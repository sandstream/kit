### Added

- **`kit check` warns when every signed-in user can read every row of a table.** A new
  `signed-in database access` row, next to `anonymous database access` in
  `src/check-anon-access.ts`, lists each table with a permissive `FOR SELECT` or `FOR ALL` policy
  `TO authenticated USING (true)`. On Supabase anyone can sign up, so such a table is close to
  public, yet `kit check --category security` passed it. The row warns, and fails at high only when
  the table has a personal-looking column (phone, email, person name, national id), by the same
  column rule as the anon row. Both rows come from one read of the SQL files.

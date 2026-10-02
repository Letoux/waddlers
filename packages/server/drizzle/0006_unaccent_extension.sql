-- S6 review F2: accent-insensitive table search (`unaccent(lower(x)) like unaccent(lower(term))`).
-- unaccent is a "trusted" extension on PostgreSQL 13+ (like citext and pg_trgm in 0000), so the
-- database owner may create it; it installs functions in the schema of the connection and PUBLIC
-- may execute them, so the DML-only `waddlers_app` role can call it (proved by roles.int.test.ts).
-- Purely additive: no table or data is touched. IF NOT EXISTS keeps a re-run safe.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Custom migration: no business tables yet (S2+).
-- citext: case-insensitive text (e.g. usernames). pg_trgm: trigram indexes for table search.
-- Both are "trusted" extensions on PostgreSQL 13+, so the database owner may create them.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;

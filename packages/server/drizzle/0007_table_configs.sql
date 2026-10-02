-- S7 (D27): persisted table view per (user, space). Purely additive: one new table, no existing
-- table or row is touched. The FK targets space_members(space_id, user_id) ON DELETE CASCADE, so
-- revoking a membership deletes that user's config for the space. The app role gets DML through
-- the default privileges set by `db:setup-roles` (no GRANT needed here). Rollback = DROP TABLE.
CREATE TABLE "table_configs" (
	"user_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_configs_user_id_space_id_pk" PRIMARY KEY("user_id","space_id"),
	CONSTRAINT "table_configs_version_positive" CHECK ("table_configs"."version" >= 1),
	CONSTRAINT "table_configs_config_size" CHECK (jsonb_typeof("table_configs"."config") = 'object' and pg_column_size("table_configs"."config") <= 16384)
);
--> statement-breakpoint
ALTER TABLE "table_configs" ADD CONSTRAINT "table_configs_member_fk" FOREIGN KEY ("space_id","user_id") REFERENCES "public"."space_members"("space_id","user_id") ON DELETE cascade ON UPDATE no action;
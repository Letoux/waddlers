ALTER TABLE "listings" DROP CONSTRAINT "listings_currency_format";--> statement-breakpoint
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_reference_currency_format";--> statement-breakpoint
ALTER TABLE "space_positions" DROP CONSTRAINT "space_positions_instrument_id_fk";
--> statement-breakpoint
DROP INDEX "space_positions_instrument_id_idx";--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_name_not_blank" CHECK (length(btrim("instruments"."name")) > 0);--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_currency_format" CHECK ("listings"."currency" ~ '^[A-Z]{3}$' or "listings"."currency" in ('GBp', 'ZAc'));--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_name_valid" CHECK (length(btrim("spaces"."name"::text)) > 0 and char_length("spaces"."name"::text) <= 64);--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_reference_currency_format" CHECK ("spaces"."reference_currency" ~ '^[A-Z]{3}$' and "spaces"."reference_currency" not in ('GBX', 'ZAC', 'ILA'));
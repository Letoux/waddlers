CREATE TABLE "exchanges" (
	"mic" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"country" text NOT NULL,
	CONSTRAINT "exchanges_mic_format" CHECK ("exchanges"."mic" ~ '^[A-Z0-9]{4}$'),
	CONSTRAINT "exchanges_country_format" CHECK ("exchanges"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"isin" text,
	"sector" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_isin_unique" UNIQUE("isin"),
	CONSTRAINT "instruments_type_check" CHECK ("instruments"."type" in ('stock', 'etf')),
	CONSTRAINT "instruments_isin_format" CHECK ("instruments"."isin" ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$')
);
--> statement-breakpoint
CREATE TABLE "listing_provider_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_symbol" text NOT NULL,
	CONSTRAINT "listing_provider_ids_listing_provider_unique" UNIQUE("listing_id","provider"),
	CONSTRAINT "listing_provider_ids_provider_symbol_unique" UNIQUE("provider","provider_symbol"),
	CONSTRAINT "listing_provider_ids_provider_format" CHECK ("listing_provider_ids"."provider" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"exchange_mic" text NOT NULL,
	"symbol" text NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_exchange_symbol_unique" UNIQUE("exchange_mic","symbol"),
	CONSTRAINT "listings_id_instrument_unique" UNIQUE("id","instrument_id"),
	CONSTRAINT "listings_currency_format" CHECK ("listings"."currency" ~ '^[A-Za-z]{3}$'),
	CONSTRAINT "listings_symbol_not_blank" CHECK (length(btrim("listings"."symbol")) > 0)
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_space_id_user_id_pk" PRIMARY KEY("space_id","user_id"),
	CONSTRAINT "space_members_role_check" CHECK ("space_members"."role" in ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "space_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"selection_reason" text,
	"quantity" numeric(24, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_positions_space_instrument_unique" UNIQUE("space_id","instrument_id"),
	CONSTRAINT "space_positions_quantity_valid" CHECK ("space_positions"."quantity" is null or ("space_positions"."quantity" >= 0 and "space_positions"."quantity" <> 'NaN'))
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" "citext" NOT NULL,
	"reference_currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_name_unique" UNIQUE("name"),
	CONSTRAINT "spaces_reference_currency_format" CHECK ("spaces"."reference_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_space_id" uuid;--> statement-breakpoint
ALTER TABLE "listing_provider_ids" ADD CONSTRAINT "listing_provider_ids_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_exchange_mic_exchanges_mic_fk" FOREIGN KEY ("exchange_mic") REFERENCES "public"."exchanges"("mic") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_positions" ADD CONSTRAINT "space_positions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_positions" ADD CONSTRAINT "space_positions_listing_instrument_fk" FOREIGN KEY ("listing_id","instrument_id") REFERENCES "public"."listings"("id","instrument_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_positions" ADD CONSTRAINT "space_positions_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_instrument_id_idx" ON "listings" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "space_members_user_id_idx" ON "space_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "space_positions_listing_id_idx" ON "space_positions" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "space_positions_instrument_id_idx" ON "space_positions" USING btree ("instrument_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_space_id_spaces_id_fk" FOREIGN KEY ("last_space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;
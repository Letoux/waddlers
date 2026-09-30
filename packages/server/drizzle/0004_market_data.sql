CREATE TABLE "fx_daily" (
	"rate_date" date NOT NULL,
	"currency" text NOT NULL,
	"rate_per_eur" numeric(20, 10) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fx_daily_rate_date_currency_pk" PRIMARY KEY("rate_date","currency"),
	CONSTRAINT "fx_daily_rate_positive" CHECK ("fx_daily"."rate_per_eur" > 0 and "fx_daily"."rate_per_eur" <> 'NaN'),
	CONSTRAINT "fx_daily_currency_format" CHECK ("fx_daily"."currency" ~ '^[A-Z]{3}$' and "fx_daily"."currency" <> 'EUR'),
	CONSTRAINT "fx_daily_source_format" CHECK ("fx_daily"."source" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "listing_metrics" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"as_of_date" date,
	"price" numeric(24, 8),
	"price_currency" text NOT NULL,
	"price_basis" text,
	"price_as_of" timestamp with time zone,
	"price_eur" numeric(24, 8),
	"price_eur_reason" text,
	"fx_rate_per_eur" numeric(20, 10),
	"fx_rate_date" date,
	"perf_1w" numeric(20, 8),
	"perf_1w_base_date" date,
	"perf_1w_reason" text,
	"perf_1m" numeric(20, 8),
	"perf_1m_base_date" date,
	"perf_1m_reason" text,
	"perf_6m" numeric(20, 8),
	"perf_6m_base_date" date,
	"perf_6m_reason" text,
	"perf_1y" numeric(20, 8),
	"perf_1y_base_date" date,
	"perf_1y_reason" text,
	"perf_5y" numeric(20, 8),
	"perf_5y_base_date" date,
	"perf_5y_reason" text,
	"perf_max" numeric(20, 8),
	"perf_max_base_date" date,
	"perf_max_reason" text,
	CONSTRAINT "listing_metrics_price_positive" CHECK ("listing_metrics"."price" is null or ("listing_metrics"."price" > 0 and "listing_metrics"."price" <> 'NaN')),
	CONSTRAINT "listing_metrics_price_eur_positive" CHECK ("listing_metrics"."price_eur" is null or ("listing_metrics"."price_eur" > 0 and "listing_metrics"."price_eur" <> 'NaN')),
	CONSTRAINT "listing_metrics_price_basis_check" CHECK ("listing_metrics"."price_basis" is null or "listing_metrics"."price_basis" in ('quote', 'close')),
	CONSTRAINT "listing_metrics_price_consistency" CHECK (("listing_metrics"."price" is null) = ("listing_metrics"."price_basis" is null) and ("listing_metrics"."price" is null) = ("listing_metrics"."as_of_date" is null)),
	CONSTRAINT "listing_metrics_price_eur_reason_check" CHECK (("listing_metrics"."price_eur" is null) = ("listing_metrics"."price_eur_reason" is not null)),
	CONSTRAINT "listing_metrics_perf_1w_consistency" CHECK (("listing_metrics"."perf_1w" is null) = ("listing_metrics"."perf_1w_reason" is not null) and ("listing_metrics"."perf_1w" is null or "listing_metrics"."perf_1w_base_date" is not null)),
	CONSTRAINT "listing_metrics_perf_1w_reason_format" CHECK ("listing_metrics"."perf_1w_reason" is null or "listing_metrics"."perf_1w_reason" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "listing_metrics_perf_1w_finite" CHECK ("listing_metrics"."perf_1w" is null or "listing_metrics"."perf_1w" <> 'NaN'),
	CONSTRAINT "listing_metrics_perf_1m_consistency" CHECK (("listing_metrics"."perf_1m" is null) = ("listing_metrics"."perf_1m_reason" is not null) and ("listing_metrics"."perf_1m" is null or "listing_metrics"."perf_1m_base_date" is not null)),
	CONSTRAINT "listing_metrics_perf_1m_reason_format" CHECK ("listing_metrics"."perf_1m_reason" is null or "listing_metrics"."perf_1m_reason" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "listing_metrics_perf_1m_finite" CHECK ("listing_metrics"."perf_1m" is null or "listing_metrics"."perf_1m" <> 'NaN'),
	CONSTRAINT "listing_metrics_perf_6m_consistency" CHECK (("listing_metrics"."perf_6m" is null) = ("listing_metrics"."perf_6m_reason" is not null) and ("listing_metrics"."perf_6m" is null or "listing_metrics"."perf_6m_base_date" is not null)),
	CONSTRAINT "listing_metrics_perf_6m_reason_format" CHECK ("listing_metrics"."perf_6m_reason" is null or "listing_metrics"."perf_6m_reason" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "listing_metrics_perf_6m_finite" CHECK ("listing_metrics"."perf_6m" is null or "listing_metrics"."perf_6m" <> 'NaN'),
	CONSTRAINT "listing_metrics_perf_1y_consistency" CHECK (("listing_metrics"."perf_1y" is null) = ("listing_metrics"."perf_1y_reason" is not null) and ("listing_metrics"."perf_1y" is null or "listing_metrics"."perf_1y_base_date" is not null)),
	CONSTRAINT "listing_metrics_perf_1y_reason_format" CHECK ("listing_metrics"."perf_1y_reason" is null or "listing_metrics"."perf_1y_reason" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "listing_metrics_perf_1y_finite" CHECK ("listing_metrics"."perf_1y" is null or "listing_metrics"."perf_1y" <> 'NaN'),
	CONSTRAINT "listing_metrics_perf_5y_consistency" CHECK (("listing_metrics"."perf_5y" is null) = ("listing_metrics"."perf_5y_reason" is not null) and ("listing_metrics"."perf_5y" is null or "listing_metrics"."perf_5y_base_date" is not null)),
	CONSTRAINT "listing_metrics_perf_5y_reason_format" CHECK ("listing_metrics"."perf_5y_reason" is null or "listing_metrics"."perf_5y_reason" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "listing_metrics_perf_5y_finite" CHECK ("listing_metrics"."perf_5y" is null or "listing_metrics"."perf_5y" <> 'NaN'),
	CONSTRAINT "listing_metrics_perf_max_consistency" CHECK (("listing_metrics"."perf_max" is null) = ("listing_metrics"."perf_max_reason" is not null) and ("listing_metrics"."perf_max" is null or "listing_metrics"."perf_max_base_date" is not null)),
	CONSTRAINT "listing_metrics_perf_max_reason_format" CHECK ("listing_metrics"."perf_max_reason" is null or "listing_metrics"."perf_max_reason" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "listing_metrics_perf_max_finite" CHECK ("listing_metrics"."perf_max" is null or "listing_metrics"."perf_max" <> 'NaN')
);
--> statement-breakpoint
CREATE TABLE "market_data_fetch_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid,
	"kind" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error_code" text,
	"history_complete_from" date,
	CONSTRAINT "market_data_fetch_state_listing_kind_unique" UNIQUE NULLS NOT DISTINCT("listing_id","kind"),
	CONSTRAINT "market_data_fetch_state_kind_check" CHECK ("market_data_fetch_state"."kind" in ('quote', 'history', 'fx')),
	CONSTRAINT "market_data_fetch_state_scope_check" CHECK (("market_data_fetch_state"."kind" = 'fx') = ("market_data_fetch_state"."listing_id" is null)),
	CONSTRAINT "market_data_fetch_state_failures_check" CHECK ("market_data_fetch_state"."failure_count" >= 0),
	CONSTRAINT "market_data_fetch_state_error_code_format" CHECK ("market_data_fetch_state"."last_error_code" is null or "market_data_fetch_state"."last_error_code" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "market_data_fetch_state_history_kind_check" CHECK ("market_data_fetch_state"."history_complete_from" is null or "market_data_fetch_state"."kind" in ('history', 'fx'))
);
--> statement-breakpoint
CREATE TABLE "price_daily" (
	"listing_id" uuid NOT NULL,
	"trade_date" date NOT NULL,
	"close" numeric(24, 8),
	"adj_close" numeric(24, 8),
	"currency" text NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "price_daily_listing_id_trade_date_pk" PRIMARY KEY("listing_id","trade_date"),
	CONSTRAINT "price_daily_close_positive" CHECK ("price_daily"."close" is null or ("price_daily"."close" > 0 and "price_daily"."close" <> 'NaN')),
	CONSTRAINT "price_daily_adj_close_positive" CHECK ("price_daily"."adj_close" is null or ("price_daily"."adj_close" > 0 and "price_daily"."adj_close" <> 'NaN')),
	CONSTRAINT "price_daily_currency_format" CHECK ("price_daily"."currency" ~ '^[A-Z]{3}$' or "price_daily"."currency" in ('GBp', 'ZAc')),
	CONSTRAINT "price_daily_source_format" CHECK ("price_daily"."source" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"provider" text NOT NULL,
	"day" date NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "provider_usage_provider_day_pk" PRIMARY KEY("provider","day"),
	CONSTRAINT "provider_usage_calls_check" CHECK ("provider_usage"."calls" >= 0),
	CONSTRAINT "provider_usage_provider_format" CHECK ("provider_usage"."provider" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "quote_latest" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"price" numeric(24, 8) NOT NULL,
	"currency" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quote_latest_price_positive" CHECK ("quote_latest"."price" > 0 and "quote_latest"."price" <> 'NaN'),
	CONSTRAINT "quote_latest_currency_format" CHECK ("quote_latest"."currency" ~ '^[A-Z]{3}$' or "quote_latest"."currency" in ('GBp', 'ZAc')),
	CONSTRAINT "quote_latest_source_format" CHECK ("quote_latest"."source" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
ALTER TABLE "listing_metrics" ADD CONSTRAINT "listing_metrics_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_data_fetch_state" ADD CONSTRAINT "market_data_fetch_state_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_daily" ADD CONSTRAINT "price_daily_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_latest" ADD CONSTRAINT "quote_latest_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fx_daily_currency_date_idx" ON "fx_daily" USING btree ("currency","rate_date");--> statement-breakpoint
CREATE INDEX "listing_metrics_price_eur_idx" ON "listing_metrics" USING btree ("price_eur") WHERE "listing_metrics"."price_eur" is not null;--> statement-breakpoint
CREATE INDEX "listing_metrics_perf_1w_idx" ON "listing_metrics" USING btree ("perf_1w") WHERE "listing_metrics"."perf_1w" is not null;--> statement-breakpoint
CREATE INDEX "listing_metrics_perf_1m_idx" ON "listing_metrics" USING btree ("perf_1m") WHERE "listing_metrics"."perf_1m" is not null;--> statement-breakpoint
CREATE INDEX "listing_metrics_perf_6m_idx" ON "listing_metrics" USING btree ("perf_6m") WHERE "listing_metrics"."perf_6m" is not null;--> statement-breakpoint
CREATE INDEX "listing_metrics_perf_1y_idx" ON "listing_metrics" USING btree ("perf_1y") WHERE "listing_metrics"."perf_1y" is not null;--> statement-breakpoint
CREATE INDEX "listing_metrics_perf_5y_idx" ON "listing_metrics" USING btree ("perf_5y") WHERE "listing_metrics"."perf_5y" is not null;--> statement-breakpoint
CREATE INDEX "listing_metrics_perf_max_idx" ON "listing_metrics" USING btree ("perf_max") WHERE "listing_metrics"."perf_max" is not null;
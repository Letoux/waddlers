-- S6: drop the seven partial indexes of 0004 on listing_metrics (price_eur, perf_*). EXPLAIN on a
-- 5 000-position space among 65 000 rows shows the planner never uses them: the table query is
-- scoped by space first and sorts the space's rows. No data change; re-add one only with an EXPLAIN
-- that proves a query needs it. IF EXISTS keeps a re-run safe.
DROP INDEX IF EXISTS "listing_metrics_price_eur_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "listing_metrics_perf_1w_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "listing_metrics_perf_1m_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "listing_metrics_perf_6m_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "listing_metrics_perf_1y_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "listing_metrics_perf_5y_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "listing_metrics_perf_max_idx";
ALTER TABLE "day_reports" ADD COLUMN "figure_day" date;--> statement-breakpoint
ALTER TABLE "day_reports" ADD COLUMN "day_change_pln" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "day_reports" ADD COLUMN "day_change_pct" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "day_reports" ADD COLUMN "figure_partial" boolean DEFAULT false NOT NULL;
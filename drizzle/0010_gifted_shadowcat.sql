ALTER TABLE "news_articles" ADD COLUMN "publisher_logo_url" text;--> statement-breakpoint
ALTER TABLE "news_articles" ADD COLUMN "publisher_favicon_url" text;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "open" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "high" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "low" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD COLUMN "volume" numeric(20, 8);
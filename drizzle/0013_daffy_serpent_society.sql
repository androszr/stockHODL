ALTER TABLE "instruments" ADD COLUMN "sector" text;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "country" char(2);--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "sic_code" text;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "profile_synced_at" timestamp with time zone;
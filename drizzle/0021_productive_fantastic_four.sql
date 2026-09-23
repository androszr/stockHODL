CREATE TABLE "day_reports" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"scope_key" text NOT NULL,
	"kind" text NOT NULL,
	"portfolio_id" uuid,
	"status" text NOT NULL,
	"portfolio_narrative" text,
	"events_narrative" text,
	"macro_narrative" text,
	"sources" jsonb,
	"facts_fingerprint" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_reports_user_id_day_scope_key_kind_pk" PRIMARY KEY("user_id","day","scope_key","kind")
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "morning_brief_last_sent_day" date;--> statement-breakpoint
ALTER TABLE "day_reports" ADD CONSTRAINT "day_reports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_reports" ADD CONSTRAINT "day_reports_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;
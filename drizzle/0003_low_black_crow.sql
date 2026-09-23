CREATE TABLE "market_calendar" (
	"date" date PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"open_at" timestamp with time zone,
	"close_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_calendar_coverage" (
	"market" text PRIMARY KEY NOT NULL,
	"known_from" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

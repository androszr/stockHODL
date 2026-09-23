CREATE TABLE "option_daily_closes" (
	"ticker" text NOT NULL,
	"as_of" date NOT NULL,
	"close" numeric(20, 8) NOT NULL,
	"source" text DEFAULT 'massive' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "option_daily_closes_ticker_as_of_pk" PRIMARY KEY("ticker","as_of")
);

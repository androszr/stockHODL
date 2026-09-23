CREATE TABLE "option_daily_marks" (
	"ticker" text NOT NULL,
	"as_of" date NOT NULL,
	"mark" numeric(20, 8) NOT NULL,
	"underlying_price" numeric(20, 8) NOT NULL,
	"implied_volatility" numeric(20, 8),
	"delta" numeric(20, 8),
	"rate" numeric(20, 8),
	"source" text DEFAULT 'bs-model' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "option_daily_marks_ticker_as_of_pk" PRIMARY KEY("ticker","as_of")
);

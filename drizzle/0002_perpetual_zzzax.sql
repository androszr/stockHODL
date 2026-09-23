CREATE TABLE "price_history_coverage" (
	"instrument_id" uuid PRIMARY KEY NOT NULL,
	"covered_from" date NOT NULL,
	"covered_to" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_history_coverage" ADD CONSTRAINT "price_history_coverage_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;
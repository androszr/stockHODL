CREATE TABLE "dividend_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"vendor_event_id" text,
	"ex_date" date NOT NULL,
	"pay_date" date,
	"quantity" numeric(20, 8) NOT NULL,
	"amount_per_share" numeric(20, 8) NOT NULL,
	"gross_amount" numeric(20, 8) NOT NULL,
	"withheld_tax" numeric(20, 8) DEFAULT '0' NOT NULL,
	"currency" char(3) NOT NULL,
	"fx_rate_to_base" numeric(20, 10),
	"source" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_dividend_vendor_portfolio" UNIQUE("vendor_event_id","portfolio_id")
);
--> statement-breakpoint
ALTER TABLE "dividend_payments" ADD CONSTRAINT "dividend_payments_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dividend_payments" ADD CONSTRAINT "dividend_payments_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_dividend_instrument_exdate" ON "dividend_payments" USING btree ("instrument_id","ex_date");--> statement-breakpoint
CREATE INDEX "ix_dividend_portfolio" ON "dividend_payments" USING btree ("portfolio_id");
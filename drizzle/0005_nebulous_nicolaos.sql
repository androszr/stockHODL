CREATE TABLE "option_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"ticker" text NOT NULL,
	"underlying" text NOT NULL,
	"contract_type" text NOT NULL,
	"strike_price" numeric(20, 8) NOT NULL,
	"expiration_date" date NOT NULL,
	"shares_per_contract" numeric(20, 8) DEFAULT '100' NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"entry_price" numeric(20, 8) NOT NULL,
	"trade_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "option_positions" ADD CONSTRAINT "option_positions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_option_positions_user" ON "option_positions" USING btree ("user_id");
CREATE TABLE "news_article_tickers" (
	"article_id" text NOT NULL,
	"ticker" text NOT NULL,
	CONSTRAINT "news_article_tickers_article_id_ticker_pk" PRIMARY KEY("article_id","ticker")
);
--> statement-breakpoint
CREATE TABLE "news_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"publisher_name" text,
	"publisher_homepage" text,
	"published_at" timestamp with time zone NOT NULL,
	"article_url" text NOT NULL,
	"image_url" text,
	"description" text,
	"keywords" jsonb,
	"insights" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_article_tickers" ADD CONSTRAINT "news_article_tickers_article_id_news_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_news_article_tickers_ticker" ON "news_article_tickers" USING btree ("ticker");
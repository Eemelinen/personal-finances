CREATE TYPE "public"."asset_class" AS ENUM('stock', 'etf', 'fund', 'crypto', 'other');--> statement-breakpoint
CREATE TYPE "public"."investment_transaction_type" AS ENUM('buy', 'sell', 'dividend', 'fee', 'transfer');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"name" text,
	"isin" char(12),
	"coingecko_id" text,
	"asset_class" "asset_class" NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_isin_unique" UNIQUE("isin"),
	CONSTRAINT "assets_coingecko_id_unique" UNIQUE("coingecko_id")
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"rate" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_date_currency_unique" UNIQUE("date","currency"),
	CONSTRAINT "fx_rates_rate_positive" CHECK ("fx_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"date" date NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holdings_account_id_asset_id_date_unique" UNIQUE("account_id","asset_id","date"),
	CONSTRAINT "holdings_quantity_not_negative" CHECK ("holdings"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "investment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"asset_id" uuid,
	"type" "investment_transaction_type" NOT NULL,
	"provider_txn_ref" text,
	"dedupe_hash" text NOT NULL,
	"trade_date" date NOT NULL,
	"quantity" numeric(38, 18),
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_transactions_account_id_provider_txn_ref_unique" UNIQUE("account_id","provider_txn_ref"),
	CONSTRAINT "investment_transactions_account_id_dedupe_hash_unique" UNIQUE("account_id","dedupe_hash")
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"date" date NOT NULL,
	"price_minor" numeric(38, 18) NOT NULL,
	"currency" char(3) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prices_asset_id_date_unique" UNIQUE("asset_id","date"),
	CONSTRAINT "prices_price_minor_not_negative" CHECK ("prices"."price_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_symbol_index" ON "assets" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "holdings_asset_id_index" ON "holdings" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "investment_transactions_account_id_trade_date_index" ON "investment_transactions" USING btree ("account_id","trade_date");--> statement-breakpoint
CREATE INDEX "investment_transactions_asset_id_index" ON "investment_transactions" USING btree ("asset_id");
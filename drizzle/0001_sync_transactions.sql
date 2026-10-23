ALTER TABLE "accounts" ADD COLUMN "transactions_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "note" text;
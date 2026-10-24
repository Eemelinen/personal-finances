CREATE TYPE "public"."transaction_source" AS ENUM('bank', 'csv');--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source" "transaction_source" DEFAULT 'bank' NOT NULL;
CREATE TYPE "public"."sync_run_kind" AS ENUM('balances', 'transactions', 'holdings');--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "kind" "sync_run_kind";
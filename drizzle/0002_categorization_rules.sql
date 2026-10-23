CREATE TYPE "public"."rule_amount_sign" AS ENUM('debit', 'credit');--> statement-breakpoint
ALTER TABLE "category_rules" ADD COLUMN "amount_sign" "rule_amount_sign";--> statement-breakpoint
ALTER TABLE "category_rules" ADD COLUMN "amount_min_minor" bigint;--> statement-breakpoint
ALTER TABLE "category_rules" ADD COLUMN "amount_max_minor" bigint;
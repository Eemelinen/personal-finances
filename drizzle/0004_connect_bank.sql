CREATE TABLE "bank_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"provider" text NOT NULL,
	"aspsp_name" text NOT NULL,
	"aspsp_country" char(2) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_authorizations_state_hash_unique" UNIQUE("state_hash")
);

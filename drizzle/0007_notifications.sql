CREATE TABLE "notifications" (
	"issue" text NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_issue_day_pk" PRIMARY KEY("issue","day")
);

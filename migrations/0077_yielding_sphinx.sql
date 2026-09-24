CREATE TABLE "quick_entry_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"template_type" varchar(30) NOT NULL,
	"config" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_entry_templates_name_check" CHECK (length(trim("quick_entry_templates"."name")) >= 1 AND length("quick_entry_templates"."name") <= 100),
	CONSTRAINT "quick_entry_templates_type_check" CHECK ("quick_entry_templates"."template_type" IN ('CREDIT_CARD_EXPENSE', 'MANUAL_EXPENSE', 'INCOME', 'RECEIVABLE', 'PAYABLE')),
	CONSTRAINT "quick_entry_templates_status_check" CHECK ("quick_entry_templates"."status" IN ('ACTIVE', 'ARCHIVED')),
	CONSTRAINT "quick_entry_templates_sort_order_check" CHECK ("quick_entry_templates"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "spending_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"default_budget_category" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spending_categories_name_check" CHECK (length(trim("spending_categories"."name")) >= 1 AND length("spending_categories"."name") <= 100),
	CONSTRAINT "spending_categories_default_budget_category_check" CHECK ("spending_categories"."default_budget_category" IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'ASK')),
	CONSTRAINT "spending_categories_status_check" CHECK ("spending_categories"."status" IN ('ACTIVE', 'ARCHIVED')),
	CONSTRAINT "spending_categories_sort_order_check" CHECK ("spending_categories"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "spending_category_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject_type" varchar(30) NOT NULL,
	"subject_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spending_category_assignments_subject_type_check" CHECK ("spending_category_assignments"."subject_type" IN ('CREDIT_CARD_PURCHASE', 'MANUAL_EXPENSE'))
);
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_purpose_check";--> statement-breakpoint
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_purpose_enrollment_grant_relation_check";--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_type_check";--> statement-breakpoint
DROP INDEX "notification_events_user_type_subject_idx";--> statement-breakpoint
ALTER TABLE "notification_events" ADD COLUMN "dedupe_key" varchar(256);--> statement-breakpoint
UPDATE "notification_events" SET "dedupe_key" = 'CC_DUE:' || "subject_id"::text WHERE "dedupe_key" IS NULL;--> statement-breakpoint
ALTER TABLE "notification_events" ALTER COLUMN "dedupe_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quick_entry_templates" ADD CONSTRAINT "quick_entry_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_categories" ADD CONSTRAINT "spending_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_category_assignments" ADD CONSTRAINT "spending_category_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_category_assignments" ADD CONSTRAINT "spending_category_assignments_category_id_spending_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."spending_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quick_entry_templates_user_idx" ON "quick_entry_templates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "quick_entry_templates_user_status_idx" ON "quick_entry_templates" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "spending_categories_user_idx" ON "spending_categories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "spending_categories_user_status_idx" ON "spending_categories" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "spending_category_assignments_user_type_subject_idx" ON "spending_category_assignments" USING btree ("user_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "spending_category_assignments_user_idx" ON "spending_category_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "spending_category_assignments_category_idx" ON "spending_category_assignments" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_user_dedupe_key_idx" ON "notification_events" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_events_user_type_subject_idx" ON "notification_events" USING btree ("user_id","notification_type","subject_id");--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_purpose_check" CHECK ("webauthn_challenges"."purpose" IN ('REGISTRATION', 'AUTHENTICATION', 'REAUTH'));--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_purpose_enrollment_grant_relation_check" CHECK (("webauthn_challenges"."purpose" = 'REGISTRATION' AND "webauthn_challenges"."enrollment_grant_id" IS NOT NULL) OR ("webauthn_challenges"."purpose" IN ('AUTHENTICATION', 'REAUTH') AND "webauthn_challenges"."enrollment_grant_id" IS NULL));--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_dedupe_key_check" CHECK (length(trim("notification_events"."dedupe_key")) >= 1 AND length("notification_events"."dedupe_key") <= 256);--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_type_check" CHECK ("notification_events"."notification_type" IN ('CREDIT_CARD_DUE', 'CREDIT_CARD_DUE_SOON', 'BUDGET_THRESHOLD', 'NO_SPEND_CHECK'));
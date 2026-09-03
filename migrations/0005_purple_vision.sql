CREATE TABLE "auth_enrollment_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"recovery_code_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_enrollment_grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_enrollment_grants_purpose_check" CHECK ("auth_enrollment_grants"."purpose" IN ('BOOTSTRAP', 'RECOVERY')),
	CONSTRAINT "auth_enrollment_grants_purpose_recovery_relation_check" CHECK (("auth_enrollment_grants"."purpose" = 'BOOTSTRAP' AND "auth_enrollment_grants"."recovery_code_id" IS NULL) OR ("auth_enrollment_grants"."purpose" = 'RECOVERY' AND "auth_enrollment_grants"."recovery_code_id" IS NOT NULL)),
	CONSTRAINT "auth_enrollment_grants_expires_at_check" CHECK ("auth_enrollment_grants"."expires_at" > "auth_enrollment_grants"."created_at"),
	CONSTRAINT "auth_enrollment_grants_consumed_at_check" CHECK ("auth_enrollment_grants"."consumed_at" IS NULL OR "auth_enrollment_grants"."consumed_at" >= "auth_enrollment_grants"."created_at"),
	CONSTRAINT "auth_enrollment_grants_revoked_at_check" CHECK ("auth_enrollment_grants"."revoked_at" IS NULL OR "auth_enrollment_grants"."revoked_at" >= "auth_enrollment_grants"."created_at"),
	CONSTRAINT "auth_enrollment_grants_state_exclusive_check" CHECK (NOT ("auth_enrollment_grants"."consumed_at" IS NOT NULL AND "auth_enrollment_grants"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "auth_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_recovery_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "auth_recovery_codes_consumed_at_check" CHECK ("auth_recovery_codes"."consumed_at" IS NULL OR "auth_recovery_codes"."consumed_at" >= "auth_recovery_codes"."created_at"),
	CONSTRAINT "auth_recovery_codes_revoked_at_check" CHECK ("auth_recovery_codes"."revoked_at" IS NULL OR "auth_recovery_codes"."revoked_at" >= "auth_recovery_codes"."created_at"),
	CONSTRAINT "auth_recovery_codes_state_exclusive_check" CHECK (NOT ("auth_recovery_codes"."consumed_at" IS NOT NULL AND "auth_recovery_codes"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_initialized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_enrollment_grants" ADD CONSTRAINT "auth_enrollment_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_enrollment_grants" ADD CONSTRAINT "auth_enrollment_grants_recovery_code_id_auth_recovery_codes_id_fk" FOREIGN KEY ("recovery_code_id") REFERENCES "public"."auth_recovery_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_codes" ADD CONSTRAINT "auth_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_enrollment_grants_single_active_purpose_idx" ON "auth_enrollment_grants" USING btree ("user_id","purpose") WHERE "auth_enrollment_grants"."consumed_at" IS NULL AND "auth_enrollment_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_recovery_codes_single_active_idx" ON "auth_recovery_codes" USING btree ("user_id") WHERE "auth_recovery_codes"."consumed_at" IS NULL AND "auth_recovery_codes"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_initialized_at_check" CHECK ("users"."auth_initialized_at" IS NULL OR "users"."auth_initialized_at" >= "users"."created_at");
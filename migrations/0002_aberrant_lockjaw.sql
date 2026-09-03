CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"challenge" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "webauthn_challenges_challenge_unique" UNIQUE("challenge"),
	CONSTRAINT "webauthn_challenges_purpose_check" CHECK ("webauthn_challenges"."purpose" IN ('REGISTRATION', 'AUTHENTICATION')),
	CONSTRAINT "webauthn_challenges_expires_at_check" CHECK ("webauthn_challenges"."expires_at" > "webauthn_challenges"."created_at"),
	CONSTRAINT "webauthn_challenges_consumed_at_check" CHECK ("webauthn_challenges"."consumed_at" IS NULL OR "webauthn_challenges"."consumed_at" >= "webauthn_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webauthn_challenges_user_purpose_idx" ON "webauthn_challenges" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "webauthn_challenges" USING btree ("expires_at");
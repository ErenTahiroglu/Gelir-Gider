CREATE TABLE "campaign_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(120) NOT NULL,
	"family_key" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_families_provider_check" CHECK ("campaign_families"."provider" = btrim("campaign_families"."provider") AND length("campaign_families"."provider") >= 1 AND length("campaign_families"."provider") <= 120),
	CONSTRAINT "campaign_families_family_key_check" CHECK ("campaign_families"."family_key" = btrim("campaign_families"."family_key") AND length("campaign_families"."family_key") >= 1 AND length("campaign_families"."family_key") <= 160)
);
--> statement-breakpoint
CREATE TABLE "campaign_period_revision_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"credit_card_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_period_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"campaign_period_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(20) NOT NULL,
	"lifecycle_status" varchar(20) NOT NULL,
	"visibility" varchar(10) NOT NULL,
	"title" varchar(200) NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"rule_mode" varchar(24) NOT NULL,
	"target_spend_amount" numeric(18, 2),
	"required_transaction_count" integer,
	"minimum_transaction_amount" numeric(18, 2),
	"step_spend_amount" numeric(18, 2),
	"reward_points_per_step" numeric(20, 4),
	"max_steps" integer,
	"reward_kind" varchar(20) NOT NULL,
	"reward_account_id" uuid,
	"expected_reward_points" numeric(20, 4),
	"merchant_scope_mode" varchar(24) NOT NULL,
	"required_canonical_merchant_names" jsonb,
	"allowed_mcc_codes" jsonb,
	"reward_expiry_date" date,
	"source_snapshot_id" uuid,
	"parser_type" varchar(60),
	"parser_version" varchar(40),
	"parser_confidence" numeric(5, 4),
	"note" varchar(1000),
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_period_revisions_rev_no_check" CHECK ("campaign_period_revisions"."revision_no" > 0),
	CONSTRAINT "campaign_period_revisions_op_check" CHECK ("campaign_period_revisions"."operation" IN ('CREATE', 'CONFIRM', 'AMEND', 'HIDE', 'RESTORE', 'END', 'CANCEL')),
	CONSTRAINT "campaign_period_revisions_lifecycle_check" CHECK ("campaign_period_revisions"."lifecycle_status" IN ('REVIEW_REQUIRED', 'ACTIVE', 'ENDED', 'CANCELLED')),
	CONSTRAINT "campaign_period_revisions_visibility_check" CHECK ("campaign_period_revisions"."visibility" IN ('VISIBLE', 'HIDDEN')),
	CONSTRAINT "campaign_period_revisions_title_check" CHECK ("campaign_period_revisions"."title" = btrim("campaign_period_revisions"."title") AND length("campaign_period_revisions"."title") >= 1 AND length("campaign_period_revisions"."title") <= 200),
	CONSTRAINT "campaign_period_revisions_date_window_check" CHECK ("campaign_period_revisions"."starts_on" <= "campaign_period_revisions"."ends_on"),
	CONSTRAINT "campaign_period_revisions_rule_mode_check" CHECK ("campaign_period_revisions"."rule_mode" IN ('TOTAL_SPEND', 'TRANSACTION_COUNT', 'REPEATABLE_SPEND')),
	CONSTRAINT "campaign_period_revisions_rule_shape_check" CHECK ((
				"campaign_period_revisions"."rule_mode" = 'TOTAL_SPEND' AND "campaign_period_revisions"."target_spend_amount" IS NOT NULL AND "campaign_period_revisions"."target_spend_amount" > 0
					AND "campaign_period_revisions"."required_transaction_count" IS NULL AND "campaign_period_revisions"."minimum_transaction_amount" IS NULL
					AND "campaign_period_revisions"."step_spend_amount" IS NULL AND "campaign_period_revisions"."reward_points_per_step" IS NULL AND "campaign_period_revisions"."max_steps" IS NULL
			) OR (
				"campaign_period_revisions"."rule_mode" = 'TRANSACTION_COUNT' AND "campaign_period_revisions"."required_transaction_count" IS NOT NULL AND "campaign_period_revisions"."required_transaction_count" >= 1
					AND ("campaign_period_revisions"."minimum_transaction_amount" IS NULL OR "campaign_period_revisions"."minimum_transaction_amount" > 0)
					AND "campaign_period_revisions"."target_spend_amount" IS NULL AND "campaign_period_revisions"."step_spend_amount" IS NULL
					AND "campaign_period_revisions"."reward_points_per_step" IS NULL AND "campaign_period_revisions"."max_steps" IS NULL
			) OR (
				"campaign_period_revisions"."rule_mode" = 'REPEATABLE_SPEND' AND "campaign_period_revisions"."step_spend_amount" IS NOT NULL AND "campaign_period_revisions"."step_spend_amount" > 0
					AND "campaign_period_revisions"."reward_points_per_step" IS NOT NULL AND "campaign_period_revisions"."reward_points_per_step" > 0
					AND "campaign_period_revisions"."max_steps" IS NOT NULL AND "campaign_period_revisions"."max_steps" >= 1
					AND ("campaign_period_revisions"."minimum_transaction_amount" IS NULL OR "campaign_period_revisions"."minimum_transaction_amount" > 0)
					AND "campaign_period_revisions"."target_spend_amount" IS NULL AND "campaign_period_revisions"."required_transaction_count" IS NULL
			)),
	CONSTRAINT "campaign_period_revisions_reward_kind_check" CHECK ("campaign_period_revisions"."reward_kind" IN ('REWARD_POINTS', 'STATEMENT_CREDIT', 'INFORMATIONAL')),
	CONSTRAINT "campaign_period_revisions_reward_shape_check" CHECK ((
				"campaign_period_revisions"."reward_kind" = 'REWARD_POINTS' AND "campaign_period_revisions"."reward_account_id" IS NOT NULL
					AND (
						("campaign_period_revisions"."rule_mode" = 'REPEATABLE_SPEND' AND "campaign_period_revisions"."expected_reward_points" IS NULL)
						OR ("campaign_period_revisions"."rule_mode" != 'REPEATABLE_SPEND' AND "campaign_period_revisions"."expected_reward_points" IS NOT NULL AND "campaign_period_revisions"."expected_reward_points" > 0)
					)
			) OR (
				"campaign_period_revisions"."reward_kind" IN ('STATEMENT_CREDIT', 'INFORMATIONAL')
					AND "campaign_period_revisions"."reward_account_id" IS NULL AND "campaign_period_revisions"."expected_reward_points" IS NULL
			)),
	CONSTRAINT "campaign_period_revisions_merchant_scope_check" CHECK ("campaign_period_revisions"."merchant_scope_mode" IN ('ALL_MERCHANTS', 'MERCHANT_ALIASES', 'MANUAL_REVIEW_REQUIRED')),
	CONSTRAINT "campaign_period_revisions_merchant_scope_shape_check" CHECK ((
				"campaign_period_revisions"."merchant_scope_mode" = 'MERCHANT_ALIASES' AND "campaign_period_revisions"."required_canonical_merchant_names" IS NOT NULL
					AND jsonb_typeof("campaign_period_revisions"."required_canonical_merchant_names") = 'array' AND jsonb_array_length("campaign_period_revisions"."required_canonical_merchant_names") >= 1
			) OR (
				"campaign_period_revisions"."merchant_scope_mode" != 'MERCHANT_ALIASES' AND "campaign_period_revisions"."required_canonical_merchant_names" IS NULL
			)),
	CONSTRAINT "campaign_period_revisions_mcc_shape_check" CHECK ("campaign_period_revisions"."allowed_mcc_codes" IS NULL OR jsonb_typeof("campaign_period_revisions"."allowed_mcc_codes") = 'array'),
	CONSTRAINT "campaign_period_revisions_parser_confidence_check" CHECK ("campaign_period_revisions"."parser_confidence" IS NULL OR ("campaign_period_revisions"."parser_confidence" >= 0 AND "campaign_period_revisions"."parser_confidence" <= 1)),
	CONSTRAINT "campaign_period_revisions_parser_shape_check" CHECK (("campaign_period_revisions"."parser_type" IS NULL) = ("campaign_period_revisions"."parser_version" IS NULL)),
	CONSTRAINT "campaign_period_revisions_note_check" CHECK ("campaign_period_revisions"."note" IS NULL OR ("campaign_period_revisions"."note" = btrim("campaign_period_revisions"."note") AND length("campaign_period_revisions"."note") >= 1 AND length("campaign_period_revisions"."note") <= 1000)),
	CONSTRAINT "campaign_period_revisions_fingerprint_check" CHECK ("campaign_period_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "campaign_period_revisions_idempotency_check" CHECK ("campaign_period_revisions"."idempotency_key" = btrim("campaign_period_revisions"."idempotency_key") AND length("campaign_period_revisions"."idempotency_key") >= 1 AND length("campaign_period_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "campaign_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"campaign_family_id" uuid NOT NULL,
	"period_key" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_periods_period_key_check" CHECK ("campaign_periods"."period_key" = btrim("campaign_periods"."period_key") AND length("campaign_periods"."period_key") >= 1 AND length("campaign_periods"."period_key") <= 160)
);
--> statement-breakpoint
CREATE TABLE "campaign_purchase_override_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"override_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"reason_note" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_purchase_override_revisions_rev_no_check" CHECK ("campaign_purchase_override_revisions"."revision_no" > 0),
	CONSTRAINT "campaign_purchase_override_revisions_op_check" CHECK ("campaign_purchase_override_revisions"."operation" IN ('INCLUDE', 'EXCLUDE', 'CLEAR')),
	CONSTRAINT "campaign_purchase_override_revisions_reason_note_check" CHECK ("campaign_purchase_override_revisions"."reason_note" IS NULL OR ("campaign_purchase_override_revisions"."reason_note" = btrim("campaign_purchase_override_revisions"."reason_note") AND length("campaign_purchase_override_revisions"."reason_note") >= 1 AND length("campaign_purchase_override_revisions"."reason_note") <= 500)),
	CONSTRAINT "campaign_purchase_override_revisions_fingerprint_check" CHECK ("campaign_purchase_override_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "campaign_purchase_override_revisions_idempotency_check" CHECK ("campaign_purchase_override_revisions"."idempotency_key" = btrim("campaign_purchase_override_revisions"."idempotency_key") AND length("campaign_purchase_override_revisions"."idempotency_key") >= 1 AND length("campaign_purchase_override_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "campaign_purchase_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"campaign_period_id" uuid NOT NULL,
	"purchase_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_reward_credit_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credit_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"actual_point_amount" numeric(20, 4) NOT NULL,
	"expected_point_amount" numeric(20, 4),
	"reason_note" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"reward_event_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_reward_credit_revisions_rev_no_check" CHECK ("campaign_reward_credit_revisions"."revision_no" > 0),
	CONSTRAINT "campaign_reward_credit_revisions_op_check" CHECK ("campaign_reward_credit_revisions"."operation" IN ('CREATE', 'VOID')),
	CONSTRAINT "campaign_reward_credit_revisions_actual_check" CHECK ("campaign_reward_credit_revisions"."actual_point_amount" > 0),
	CONSTRAINT "campaign_reward_credit_revisions_expected_check" CHECK ("campaign_reward_credit_revisions"."expected_point_amount" IS NULL OR "campaign_reward_credit_revisions"."expected_point_amount" > 0),
	CONSTRAINT "campaign_reward_credit_revisions_reason_note_check" CHECK ("campaign_reward_credit_revisions"."reason_note" IS NULL OR ("campaign_reward_credit_revisions"."reason_note" = btrim("campaign_reward_credit_revisions"."reason_note") AND length("campaign_reward_credit_revisions"."reason_note") >= 1 AND length("campaign_reward_credit_revisions"."reason_note") <= 500)),
	CONSTRAINT "campaign_reward_credit_revisions_fingerprint_check" CHECK ("campaign_reward_credit_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "campaign_reward_credit_revisions_idempotency_check" CHECK ("campaign_reward_credit_revisions"."idempotency_key" = btrim("campaign_reward_credit_revisions"."idempotency_key") AND length("campaign_reward_credit_revisions"."idempotency_key") >= 1 AND length("campaign_reward_credit_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "campaign_reward_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"campaign_period_id" uuid NOT NULL,
	"reward_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_source_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(120) NOT NULL,
	"source_type" varchar(24) NOT NULL,
	"source_url" varchar(2048),
	"external_source_id" varchar(200),
	"source_title" varchar(300),
	"source_text" varchar(20000),
	"content_hash" varchar(64) NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_source_snapshots_source_type_check" CHECK ("campaign_source_snapshots"."source_type" IN ('MANUAL', 'OFFICIAL_PUBLIC_PAGE', 'IMPORT')),
	CONSTRAINT "campaign_source_snapshots_https_check" CHECK ("campaign_source_snapshots"."source_url" IS NULL OR "campaign_source_snapshots"."source_url" LIKE 'https://%'),
	CONSTRAINT "campaign_source_snapshots_content_hash_check" CHECK ("campaign_source_snapshots"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "campaign_source_snapshots_provider_check" CHECK ("campaign_source_snapshots"."provider" = btrim("campaign_source_snapshots"."provider") AND length("campaign_source_snapshots"."provider") >= 1 AND length("campaign_source_snapshots"."provider") <= 120)
);
--> statement-breakpoint
CREATE TABLE "merchant_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_normalized_alias" varchar(200) NOT NULL,
	"canonical_merchant_name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_aliases_raw_check" CHECK ("merchant_aliases"."raw_normalized_alias" = btrim("merchant_aliases"."raw_normalized_alias") AND length("merchant_aliases"."raw_normalized_alias") >= 1 AND length("merchant_aliases"."raw_normalized_alias") <= 200),
	CONSTRAINT "merchant_aliases_canonical_check" CHECK ("merchant_aliases"."canonical_merchant_name" = btrim("merchant_aliases"."canonical_merchant_name") AND length("merchant_aliases"."canonical_merchant_name") >= 1 AND length("merchant_aliases"."canonical_merchant_name") <= 200)
);
--> statement-breakpoint
ALTER TABLE "campaign_families" ADD CONSTRAINT "campaign_families_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_period_revision_cards" ADD CONSTRAINT "campaign_period_revision_cards_revision_id_campaign_period_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."campaign_period_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_period_revision_cards" ADD CONSTRAINT "campaign_period_revision_cards_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_period_revisions" ADD CONSTRAINT "campaign_period_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_period_revisions" ADD CONSTRAINT "campaign_period_revisions_campaign_period_id_campaign_periods_id_fk" FOREIGN KEY ("campaign_period_id") REFERENCES "public"."campaign_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_period_revisions" ADD CONSTRAINT "campaign_period_revisions_previous_revision_id_campaign_period_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."campaign_period_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_period_revisions" ADD CONSTRAINT "campaign_period_revisions_reward_account_id_reward_accounts_id_fk" FOREIGN KEY ("reward_account_id") REFERENCES "public"."reward_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_period_revisions" ADD CONSTRAINT "campaign_period_revisions_source_snapshot_id_campaign_source_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."campaign_source_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_periods" ADD CONSTRAINT "campaign_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_periods" ADD CONSTRAINT "campaign_periods_campaign_family_id_campaign_families_id_fk" FOREIGN KEY ("campaign_family_id") REFERENCES "public"."campaign_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_purchase_override_revisions" ADD CONSTRAINT "campaign_purchase_override_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_purchase_override_revisions" ADD CONSTRAINT "campaign_purchase_override_revisions_override_id_campaign_purchase_overrides_id_fk" FOREIGN KEY ("override_id") REFERENCES "public"."campaign_purchase_overrides"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_purchase_override_revisions" ADD CONSTRAINT "campaign_purchase_override_revisions_previous_revision_id_campaign_purchase_override_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."campaign_purchase_override_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_purchase_overrides" ADD CONSTRAINT "campaign_purchase_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_purchase_overrides" ADD CONSTRAINT "campaign_purchase_overrides_campaign_period_id_campaign_periods_id_fk" FOREIGN KEY ("campaign_period_id") REFERENCES "public"."campaign_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_purchase_overrides" ADD CONSTRAINT "campaign_purchase_overrides_purchase_event_id_credit_card_liability_events_id_fk" FOREIGN KEY ("purchase_event_id") REFERENCES "public"."credit_card_liability_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reward_credit_revisions" ADD CONSTRAINT "campaign_reward_credit_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reward_credit_revisions" ADD CONSTRAINT "campaign_reward_credit_revisions_credit_id_campaign_reward_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."campaign_reward_credits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reward_credit_revisions" ADD CONSTRAINT "campaign_reward_credit_revisions_previous_revision_id_campaign_reward_credit_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."campaign_reward_credit_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reward_credit_revisions" ADD CONSTRAINT "campaign_reward_credit_revisions_reward_event_id_reward_events_id_fk" FOREIGN KEY ("reward_event_id") REFERENCES "public"."reward_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reward_credits" ADD CONSTRAINT "campaign_reward_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reward_credits" ADD CONSTRAINT "campaign_reward_credits_campaign_period_id_campaign_periods_id_fk" FOREIGN KEY ("campaign_period_id") REFERENCES "public"."campaign_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reward_credits" ADD CONSTRAINT "campaign_reward_credits_reward_account_id_reward_accounts_id_fk" FOREIGN KEY ("reward_account_id") REFERENCES "public"."reward_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_source_snapshots" ADD CONSTRAINT "campaign_source_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_aliases" ADD CONSTRAINT "merchant_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_families_user_provider_key_idx" ON "campaign_families" USING btree ("user_id","provider","family_key");--> statement-breakpoint
CREATE INDEX "campaign_families_user_idx" ON "campaign_families" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_period_revision_cards_rev_card_idx" ON "campaign_period_revision_cards" USING btree ("revision_id","credit_card_id");--> statement-breakpoint
CREATE INDEX "campaign_period_revision_cards_revision_idx" ON "campaign_period_revision_cards" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "campaign_period_revision_cards_card_idx" ON "campaign_period_revision_cards" USING btree ("credit_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_period_revisions_period_rev_idx" ON "campaign_period_revisions" USING btree ("campaign_period_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_period_revisions_user_idempotency_idx" ON "campaign_period_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_period_revisions_prev_rev_idx" ON "campaign_period_revisions" USING btree ("previous_revision_id") WHERE "campaign_period_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_period_revisions_period_idx" ON "campaign_period_revisions" USING btree ("campaign_period_id");--> statement-breakpoint
CREATE INDEX "campaign_period_revisions_user_idx" ON "campaign_period_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaign_period_revisions_status_idx" ON "campaign_period_revisions" USING btree ("lifecycle_status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_periods_family_period_key_idx" ON "campaign_periods" USING btree ("campaign_family_id","period_key");--> statement-breakpoint
CREATE INDEX "campaign_periods_user_idx" ON "campaign_periods" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaign_periods_family_idx" ON "campaign_periods" USING btree ("campaign_family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_purchase_override_revisions_override_rev_idx" ON "campaign_purchase_override_revisions" USING btree ("override_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_purchase_override_revisions_user_idempotency_idx" ON "campaign_purchase_override_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_purchase_override_revisions_prev_rev_idx" ON "campaign_purchase_override_revisions" USING btree ("previous_revision_id") WHERE "campaign_purchase_override_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_purchase_override_revisions_override_idx" ON "campaign_purchase_override_revisions" USING btree ("override_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_purchase_overrides_period_purchase_idx" ON "campaign_purchase_overrides" USING btree ("campaign_period_id","purchase_event_id");--> statement-breakpoint
CREATE INDEX "campaign_purchase_overrides_period_idx" ON "campaign_purchase_overrides" USING btree ("campaign_period_id");--> statement-breakpoint
CREATE INDEX "campaign_purchase_overrides_user_idx" ON "campaign_purchase_overrides" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_reward_credit_revisions_credit_rev_idx" ON "campaign_reward_credit_revisions" USING btree ("credit_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_reward_credit_revisions_user_idempotency_idx" ON "campaign_reward_credit_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_reward_credit_revisions_prev_rev_idx" ON "campaign_reward_credit_revisions" USING btree ("previous_revision_id") WHERE "campaign_reward_credit_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_reward_credit_revisions_reward_event_idx" ON "campaign_reward_credit_revisions" USING btree ("reward_event_id") WHERE "campaign_reward_credit_revisions"."operation" = 'CREATE';--> statement-breakpoint
CREATE INDEX "campaign_reward_credit_revisions_credit_idx" ON "campaign_reward_credit_revisions" USING btree ("credit_id");--> statement-breakpoint
CREATE INDEX "campaign_reward_credits_period_idx" ON "campaign_reward_credits" USING btree ("campaign_period_id");--> statement-breakpoint
CREATE INDEX "campaign_reward_credits_user_idx" ON "campaign_reward_credits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaign_source_snapshots_user_idx" ON "campaign_source_snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaign_source_snapshots_provider_idx" ON "campaign_source_snapshots" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "campaign_source_snapshots_content_hash_idx" ON "campaign_source_snapshots" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "merchant_aliases_user_alias_idx" ON "merchant_aliases" USING btree ("user_id","raw_normalized_alias");--> statement-breakpoint

-- ============================================================================
-- PHASE 16: CREDIT CARD CAMPAIGN TRACKING DOMAIN INTEGRITY
--
-- A. Immutability (INSERT-only) on all ten new campaign tables.
-- B. campaign_period_revisions: ownership + revision chain + lifecycle
--    transition guard (BEFORE INSERT).
-- C. campaign_period_revision_cards: ownership guard (BEFORE INSERT).
-- D. Anchor completeness (deferred): naked family/period/override/credit
--    anchors + ACTIVE/ENDED campaign period revision card-scope completeness.
-- E. campaign_purchase_overrides + revisions: ownership + purchase identity +
--    card-scope + chain guard (BEFORE INSERT).
-- F. campaign_reward_credits + revisions: ownership + reward account binding
--    + exact reward-event provenance + single-active-identity guard.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. IMMUTABILITY
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_campaigns()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'Table % is immutable (INSERT-only)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_families ON "campaign_families";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_families
BEFORE UPDATE OR DELETE ON "campaign_families"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_periods ON "campaign_periods";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_periods
BEFORE UPDATE OR DELETE ON "campaign_periods"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_period_revisions ON "campaign_period_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_period_revisions
BEFORE UPDATE OR DELETE ON "campaign_period_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_period_revision_cards ON "campaign_period_revision_cards";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_period_revision_cards
BEFORE UPDATE OR DELETE ON "campaign_period_revision_cards"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_source_snapshots ON "campaign_source_snapshots";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_source_snapshots
BEFORE UPDATE OR DELETE ON "campaign_source_snapshots"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_merchant_aliases ON "merchant_aliases";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_merchant_aliases
BEFORE UPDATE OR DELETE ON "merchant_aliases"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_purchase_overrides ON "campaign_purchase_overrides";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_purchase_overrides
BEFORE UPDATE OR DELETE ON "campaign_purchase_overrides"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_purchase_override_revisions ON "campaign_purchase_override_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_purchase_override_revisions
BEFORE UPDATE OR DELETE ON "campaign_purchase_override_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_reward_credits ON "campaign_reward_credits";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_reward_credits
BEFORE UPDATE OR DELETE ON "campaign_reward_credits"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_reward_credit_revisions ON "campaign_reward_credit_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_reward_credit_revisions
BEFORE UPDATE OR DELETE ON "campaign_reward_credit_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- B. CAMPAIGN PERIOD REVISION CHAIN + LIFECYCLE TRANSITION GUARD
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_period_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_period RECORD;
	v_latest RECORD;
	v_reward_account RECORD;
	v_unchanged BOOLEAN;
BEGIN
	SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign period % not found', NEW.campaign_period_id;
	END IF;
	IF v_period.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Campaign period user_id % does not match revision user_id %', v_period.user_id, NEW.user_id;
	END IF;

	IF NEW.reward_kind = 'REWARD_POINTS' THEN
		SELECT * INTO v_reward_account FROM reward_accounts WHERE id = NEW.reward_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
		END IF;
		IF v_reward_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Reward account user_id % does not match revision user_id %', v_reward_account.user_id, NEW.user_id;
		END IF;
	END IF;

	SELECT id, revision_no, operation, lifecycle_status, visibility, title, starts_on, ends_on,
		rule_mode, target_spend_amount, required_transaction_count, minimum_transaction_amount,
		step_spend_amount, reward_points_per_step, max_steps, reward_kind, reward_account_id,
		expected_reward_points, merchant_scope_mode, required_canonical_merchant_names,
		allowed_mcc_codes, reward_expiry_date
	INTO v_latest
	FROM campaign_period_revisions
	WHERE campaign_period_id = NEW.campaign_period_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Campaign period % already has revisions; revision 1 cannot be created again', NEW.campaign_period_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.lifecycle_status != 'REVIEW_REQUIRED' THEN
			RAISE EXCEPTION 'First revision must have lifecycle_status REVIEW_REQUIRED, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != 'VISIBLE' THEN
			RAISE EXCEPTION 'First revision must have visibility VISIBLE, found %', NEW.visibility;
		END IF;
		RETURN NEW;
	END IF;

	IF v_latest.id IS NULL THEN
		RAISE EXCEPTION 'No predecessor revision exists for campaign period %', NEW.campaign_period_id;
	END IF;
	IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
		RAISE EXCEPTION 'Previous revision % is not current latest revision % of campaign period % (branching forbidden)',
			NEW.previous_revision_id, v_latest.id, NEW.campaign_period_id;
	END IF;
	IF v_latest.revision_no != (NEW.revision_no - 1) THEN
		RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
	END IF;
	IF v_latest.lifecycle_status = 'CANCELLED' THEN
		RAISE EXCEPTION 'Cannot create revision on CANCELLED campaign period % (CANCELLED is terminal)', NEW.campaign_period_id;
	END IF;

	v_unchanged := (
		NEW.title IS NOT DISTINCT FROM v_latest.title AND
		NEW.starts_on IS NOT DISTINCT FROM v_latest.starts_on AND
		NEW.ends_on IS NOT DISTINCT FROM v_latest.ends_on AND
		NEW.rule_mode IS NOT DISTINCT FROM v_latest.rule_mode AND
		NEW.target_spend_amount IS NOT DISTINCT FROM v_latest.target_spend_amount AND
		NEW.required_transaction_count IS NOT DISTINCT FROM v_latest.required_transaction_count AND
		NEW.minimum_transaction_amount IS NOT DISTINCT FROM v_latest.minimum_transaction_amount AND
		NEW.step_spend_amount IS NOT DISTINCT FROM v_latest.step_spend_amount AND
		NEW.reward_points_per_step IS NOT DISTINCT FROM v_latest.reward_points_per_step AND
		NEW.max_steps IS NOT DISTINCT FROM v_latest.max_steps AND
		NEW.reward_kind IS NOT DISTINCT FROM v_latest.reward_kind AND
		NEW.reward_account_id IS NOT DISTINCT FROM v_latest.reward_account_id AND
		NEW.expected_reward_points IS NOT DISTINCT FROM v_latest.expected_reward_points AND
		NEW.merchant_scope_mode IS NOT DISTINCT FROM v_latest.merchant_scope_mode AND
		NEW.required_canonical_merchant_names IS NOT DISTINCT FROM v_latest.required_canonical_merchant_names AND
		NEW.allowed_mcc_codes IS NOT DISTINCT FROM v_latest.allowed_mcc_codes AND
		NEW.reward_expiry_date IS NOT DISTINCT FROM v_latest.reward_expiry_date
	);

	IF NEW.operation = 'CREATE' THEN
		RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
	ELSIF NEW.operation = 'CONFIRM' THEN
		IF v_latest.lifecycle_status != 'REVIEW_REQUIRED' THEN
			RAISE EXCEPTION 'CONFIRM requires lifecycle_status REVIEW_REQUIRED, found %', v_latest.lifecycle_status;
		END IF;
		IF NEW.lifecycle_status != 'ACTIVE' THEN
			RAISE EXCEPTION 'CONFIRM must set lifecycle_status ACTIVE, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != v_latest.visibility THEN
			RAISE EXCEPTION 'CONFIRM must not change visibility';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'CONFIRM must not change economic/rule/reward/merchant-scope terms; use AMEND instead';
		END IF;
	ELSIF NEW.operation = 'AMEND' THEN
		IF v_latest.lifecycle_status != 'ACTIVE' THEN
			RAISE EXCEPTION 'AMEND requires lifecycle_status ACTIVE, found %', v_latest.lifecycle_status;
		END IF;
		IF NEW.lifecycle_status != 'ACTIVE' THEN
			RAISE EXCEPTION 'AMEND must keep lifecycle_status ACTIVE, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != v_latest.visibility THEN
			RAISE EXCEPTION 'AMEND must not change visibility; use HIDE/RESTORE instead';
		END IF;
	ELSIF NEW.operation = 'HIDE' THEN
		IF v_latest.visibility != 'VISIBLE' THEN
			RAISE EXCEPTION 'HIDE requires visibility VISIBLE, found %', v_latest.visibility;
		END IF;
		IF NEW.visibility != 'HIDDEN' THEN
			RAISE EXCEPTION 'HIDE must set visibility HIDDEN, found %', NEW.visibility;
		END IF;
		IF NEW.lifecycle_status != v_latest.lifecycle_status THEN
			RAISE EXCEPTION 'HIDE must not change lifecycle_status';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'HIDE must not change economic/rule/reward/merchant-scope terms';
		END IF;
	ELSIF NEW.operation = 'RESTORE' THEN
		IF v_latest.visibility != 'HIDDEN' THEN
			RAISE EXCEPTION 'RESTORE requires visibility HIDDEN, found %', v_latest.visibility;
		END IF;
		IF NEW.visibility != 'VISIBLE' THEN
			RAISE EXCEPTION 'RESTORE must set visibility VISIBLE, found %', NEW.visibility;
		END IF;
		IF NEW.lifecycle_status != v_latest.lifecycle_status THEN
			RAISE EXCEPTION 'RESTORE must not change lifecycle_status';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'RESTORE must not change economic/rule/reward/merchant-scope terms';
		END IF;
	ELSIF NEW.operation = 'END' THEN
		IF v_latest.lifecycle_status != 'ACTIVE' THEN
			RAISE EXCEPTION 'END requires lifecycle_status ACTIVE, found %', v_latest.lifecycle_status;
		END IF;
		IF NEW.lifecycle_status != 'ENDED' THEN
			RAISE EXCEPTION 'END must set lifecycle_status ENDED, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != v_latest.visibility THEN
			RAISE EXCEPTION 'END must not change visibility';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'END must not change economic/rule/reward/merchant-scope terms';
		END IF;
	ELSIF NEW.operation = 'CANCEL' THEN
		IF v_latest.lifecycle_status NOT IN ('REVIEW_REQUIRED', 'ACTIVE') THEN
			RAISE EXCEPTION 'CANCEL requires lifecycle_status REVIEW_REQUIRED or ACTIVE, found %', v_latest.lifecycle_status;
		END IF;
		IF NEW.lifecycle_status != 'CANCELLED' THEN
			RAISE EXCEPTION 'CANCEL must set lifecycle_status CANCELLED, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != v_latest.visibility THEN
			RAISE EXCEPTION 'CANCEL must not change visibility';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'CANCEL must not change economic/rule/reward/merchant-scope terms';
		END IF;
	ELSE
		RAISE EXCEPTION 'Unknown campaign period revision operation %', NEW.operation;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_period_revision_insert ON "campaign_period_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_period_revision_insert
BEFORE INSERT ON "campaign_period_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_period_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- C. CAMPAIGN PERIOD REVISION CARDS: OWNERSHIP GUARD
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_period_revision_card_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_period_user_id UUID;
	v_card RECORD;
BEGIN
	SELECT cp.user_id INTO v_period_user_id
	FROM campaign_period_revisions cpr
	JOIN campaign_periods cp ON cp.id = cpr.campaign_period_id
	WHERE cpr.id = NEW.revision_id;

	IF v_period_user_id IS NULL THEN
		RAISE EXCEPTION 'Campaign period revision % not found', NEW.revision_id;
	END IF;

	SELECT * INTO v_card FROM credit_cards WHERE id = NEW.credit_card_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card % not found', NEW.credit_card_id;
	END IF;
	IF v_card.user_id != v_period_user_id THEN
		RAISE EXCEPTION 'Credit card % does not belong to campaign period user %', NEW.credit_card_id, v_period_user_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_period_revision_card_insert ON "campaign_period_revision_cards";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_period_revision_card_insert
BEFORE INSERT ON "campaign_period_revision_cards"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_period_revision_card_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- D. ANCHOR COMPLETENESS (DEFERRED)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	IF TG_TABLE_NAME = 'campaign_families' THEN
		SELECT EXISTS(SELECT 1 FROM campaign_periods WHERE campaign_family_id = NEW.id) INTO v_found;
		IF NOT v_found THEN
			RAISE EXCEPTION 'Campaign family % has no periods at commit (naked family anchor)', NEW.id;
		END IF;
	ELSIF TG_TABLE_NAME = 'campaign_periods' THEN
		SELECT EXISTS(SELECT 1 FROM campaign_period_revisions WHERE campaign_period_id = NEW.id) INTO v_found;
		IF NOT v_found THEN
			RAISE EXCEPTION 'Campaign period % has no revisions at commit (naked period anchor)', NEW.id;
		END IF;
	ELSIF TG_TABLE_NAME = 'campaign_purchase_overrides' THEN
		SELECT EXISTS(SELECT 1 FROM campaign_purchase_override_revisions WHERE override_id = NEW.id) INTO v_found;
		IF NOT v_found THEN
			RAISE EXCEPTION 'Campaign purchase override % has no revisions at commit (naked override anchor)', NEW.id;
		END IF;
	ELSIF TG_TABLE_NAME = 'campaign_reward_credits' THEN
		SELECT EXISTS(SELECT 1 FROM campaign_reward_credit_revisions WHERE credit_id = NEW.id) INTO v_found;
		IF NOT v_found THEN
			RAISE EXCEPTION 'Campaign reward credit % has no revisions at commit (naked credit anchor)', NEW.id;
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_family_anchor_completeness ON "campaign_families";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_campaign_family_anchor_completeness
AFTER INSERT ON "campaign_families"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_anchor_completeness();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_period_anchor_completeness ON "campaign_periods";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_campaign_period_anchor_completeness
AFTER INSERT ON "campaign_periods"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_anchor_completeness();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_purchase_override_anchor_completeness ON "campaign_purchase_overrides";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_campaign_purchase_override_anchor_completeness
AFTER INSERT ON "campaign_purchase_overrides"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_anchor_completeness();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_reward_credit_anchor_completeness ON "campaign_reward_credits";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_campaign_reward_credit_anchor_completeness
AFTER INSERT ON "campaign_reward_credits"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_anchor_completeness();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_period_card_scope_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_card_count INT;
BEGIN
	IF NEW.lifecycle_status IN ('ACTIVE', 'ENDED') THEN
		SELECT count(*) INTO v_card_count FROM campaign_period_revision_cards WHERE revision_id = NEW.id;
		IF v_card_count = 0 THEN
			RAISE EXCEPTION 'Campaign period revision % is % but has zero linked cards at commit', NEW.id, NEW.lifecycle_status;
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_period_card_scope_completeness ON "campaign_period_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_campaign_period_card_scope_completeness
AFTER INSERT ON "campaign_period_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_period_card_scope_completeness();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- E. CAMPAIGN PURCHASE OVERRIDES: OWNERSHIP + PURCHASE IDENTITY + CARD SCOPE
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_purchase_override_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_period RECORD;
	v_event RECORD;
	v_latest_revision_id UUID;
	v_card_in_scope BOOLEAN;
BEGIN
	SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign period % not found', NEW.campaign_period_id;
	END IF;
	IF v_period.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Campaign period user_id % does not match override user_id %', v_period.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.purchase_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card liability event % not found', NEW.purchase_event_id;
	END IF;
	IF v_event.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Purchase event user_id % does not match override user_id %', v_event.user_id, NEW.user_id;
	END IF;
	IF v_event.event_type != 'PURCHASE' THEN
		RAISE EXCEPTION 'Override purchase_event_id % is not a PURCHASE identity (found %)', NEW.purchase_event_id, v_event.event_type;
	END IF;

	SELECT id INTO v_latest_revision_id
	FROM campaign_period_revisions
	WHERE campaign_period_id = NEW.campaign_period_id
	ORDER BY revision_no DESC
	LIMIT 1;

	SELECT EXISTS(
		SELECT 1 FROM campaign_period_revision_cards
		WHERE revision_id = v_latest_revision_id AND credit_card_id = v_event.credit_card_id
	) INTO v_card_in_scope;

	IF NOT v_card_in_scope THEN
		RAISE EXCEPTION 'Purchase event % card % is not within campaign period % card scope', NEW.purchase_event_id, v_event.credit_card_id, NEW.campaign_period_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_purchase_override_insert ON "campaign_purchase_overrides";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_purchase_override_insert
BEFORE INSERT ON "campaign_purchase_overrides"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_purchase_override_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_purchase_override_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_override RECORD;
	v_latest RECORD;
BEGIN
	SELECT * INTO v_override FROM campaign_purchase_overrides WHERE id = NEW.override_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign purchase override % not found', NEW.override_id;
	END IF;
	IF v_override.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Override user_id % does not match revision user_id %', v_override.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no INTO v_latest
	FROM campaign_purchase_override_revisions
	WHERE override_id = NEW.override_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Override % already has revisions; revision 1 cannot be created again', NEW.override_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for override %', NEW.override_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of override % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.override_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_purchase_override_revision_insert ON "campaign_purchase_override_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_purchase_override_revision_insert
BEFORE INSERT ON "campaign_purchase_override_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_purchase_override_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- F. CAMPAIGN REWARD CREDITS: OWNERSHIP + BINDING + SINGLE-ACTIVE-IDENTITY
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_reward_credit_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_period RECORD;
	v_reward_account RECORD;
	v_latest_period_rev RECORD;
	v_existing RECORD;
	v_existing_latest RECORD;
BEGIN
	SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign period % not found', NEW.campaign_period_id;
	END IF;
	IF v_period.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Campaign period user_id % does not match credit user_id %', v_period.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_reward_account FROM reward_accounts WHERE id = NEW.reward_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
	END IF;
	IF v_reward_account.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reward account user_id % does not match credit user_id %', v_reward_account.user_id, NEW.user_id;
	END IF;

	SELECT lifecycle_status, reward_kind, reward_account_id INTO v_latest_period_rev
	FROM campaign_period_revisions
	WHERE campaign_period_id = NEW.campaign_period_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF v_latest_period_rev IS NULL THEN
		RAISE EXCEPTION 'Campaign period % has no revisions', NEW.campaign_period_id;
	END IF;
	IF v_latest_period_rev.lifecycle_status NOT IN ('ACTIVE', 'ENDED') THEN
		RAISE EXCEPTION 'Campaign period % is not ACTIVE/ENDED (found %)', NEW.campaign_period_id, v_latest_period_rev.lifecycle_status;
	END IF;
	IF v_latest_period_rev.reward_kind != 'REWARD_POINTS' THEN
		RAISE EXCEPTION 'Campaign period % reward_kind is not REWARD_POINTS (found %)', NEW.campaign_period_id, v_latest_period_rev.reward_kind;
	END IF;
	IF v_latest_period_rev.reward_account_id != NEW.reward_account_id THEN
		RAISE EXCEPTION 'Campaign period % is bound to reward account % not %', NEW.campaign_period_id, v_latest_period_rev.reward_account_id, NEW.reward_account_id;
	END IF;

	FOR v_existing IN
		SELECT id FROM campaign_reward_credits WHERE campaign_period_id = NEW.campaign_period_id AND id != NEW.id
	LOOP
		SELECT operation INTO v_existing_latest
		FROM campaign_reward_credit_revisions
		WHERE credit_id = v_existing.id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF v_existing_latest.operation IS DISTINCT FROM 'VOID' THEN
			RAISE EXCEPTION 'Campaign period % already has an ACTIVE reward credit identity %', NEW.campaign_period_id, v_existing.id;
		END IF;
	END LOOP;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_reward_credit_insert ON "campaign_reward_credits";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_reward_credit_insert
BEFORE INSERT ON "campaign_reward_credits"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_reward_credit_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_reward_credit_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_credit RECORD;
	v_latest RECORD;
	v_reward_event RECORD;
	v_reward_event_rev RECORD;
BEGIN
	SELECT * INTO v_credit FROM campaign_reward_credits WHERE id = NEW.credit_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign reward credit % not found', NEW.credit_id;
	END IF;
	IF v_credit.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Credit user_id % does not match revision user_id %', v_credit.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no, operation, reward_event_id, actual_point_amount, expected_point_amount
	INTO v_latest
	FROM campaign_reward_credit_revisions
	WHERE credit_id = NEW.credit_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Credit % already has revisions; revision 1 cannot be created again', NEW.credit_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;

		SELECT * INTO v_reward_event FROM reward_events WHERE id = NEW.reward_event_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reward event % not found', NEW.reward_event_id;
		END IF;
		IF v_reward_event.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Reward event user_id % does not match revision user_id %', v_reward_event.user_id, NEW.user_id;
		END IF;
		IF v_reward_event.reward_account_id != v_credit.reward_account_id THEN
			RAISE EXCEPTION 'Reward event % reward_account_id % does not match credit reward_account_id %',
				NEW.reward_event_id, v_reward_event.reward_account_id, v_credit.reward_account_id;
		END IF;
		IF v_reward_event.event_type != 'EARN' THEN
			RAISE EXCEPTION 'Reward event % must have event_type EARN, found %', NEW.reward_event_id, v_reward_event.event_type;
		END IF;

		SELECT * INTO v_reward_event_rev
		FROM reward_event_revisions
		WHERE reward_event_id = NEW.reward_event_id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reward event % has no revisions', NEW.reward_event_id;
		END IF;
		IF v_reward_event_rev.source_type != 'CAMPAIGN' THEN
			RAISE EXCEPTION 'Reward event % source_type must be CAMPAIGN, found %', NEW.reward_event_id, v_reward_event_rev.source_type;
		END IF;
		IF v_reward_event_rev.source_ref IS DISTINCT FROM v_credit.campaign_period_id::text THEN
			RAISE EXCEPTION 'Reward event % source_ref % does not match campaign_period_id %',
				NEW.reward_event_id, v_reward_event_rev.source_ref, v_credit.campaign_period_id;
		END IF;
		IF v_reward_event_rev.point_amount != NEW.actual_point_amount THEN
			RAISE EXCEPTION 'Reward event % point_amount % does not match actual_point_amount %',
				NEW.reward_event_id, v_reward_event_rev.point_amount, NEW.actual_point_amount;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for credit %', NEW.credit_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of credit % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.credit_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID credit % (VOID is terminal)', NEW.credit_id;
		END IF;
		IF NEW.operation != 'VOID' THEN
			RAISE EXCEPTION 'Only VOID is permitted as a subsequent credit revision, found %', NEW.operation;
		END IF;
		IF NEW.reward_event_id != v_latest.reward_event_id THEN
			RAISE EXCEPTION 'VOID revision must reference the same reward_event_id %', v_latest.reward_event_id;
		END IF;
		IF NEW.actual_point_amount != v_latest.actual_point_amount THEN
			RAISE EXCEPTION 'VOID revision must keep the same actual_point_amount %', v_latest.actual_point_amount;
		END IF;
		IF NEW.expected_point_amount IS DISTINCT FROM v_latest.expected_point_amount THEN
			RAISE EXCEPTION 'VOID revision must keep the same expected_point_amount';
		END IF;

		SELECT operation INTO v_reward_event_rev
		FROM reward_event_revisions
		WHERE reward_event_id = NEW.reward_event_id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF v_reward_event_rev.operation IS DISTINCT FROM 'VOID' THEN
			RAISE EXCEPTION 'Reward event % must already be VOID before recording campaign credit VOID', NEW.reward_event_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_reward_credit_revision_insert ON "campaign_reward_credit_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_reward_credit_revision_insert
BEFORE INSERT ON "campaign_reward_credit_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_reward_credit_revision_insert();
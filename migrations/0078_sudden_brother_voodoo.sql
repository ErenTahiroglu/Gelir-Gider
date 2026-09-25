CREATE TABLE "person_receivable_settlement_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"cash_amount" numeric(18, 2) NOT NULL,
	"destination_asset_account_id" uuid NOT NULL,
	"is_cash" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_receivable_settlement_requests_amount_check" CHECK ("person_receivable_settlement_requests"."cash_amount" > 0),
	CONSTRAINT "person_receivable_settlement_requests_fingerprint_check" CHECK ("person_receivable_settlement_requests"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "person_receivable_settlement_requests_idempotency_check" CHECK ("person_receivable_settlement_requests"."idempotency_key" = btrim("person_receivable_settlement_requests"."idempotency_key") AND length("person_receivable_settlement_requests"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "person_receivable_settlement_requests" ADD CONSTRAINT "person_receivable_settlement_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_receivable_settlement_requests" ADD CONSTRAINT "person_receivable_settlement_requests_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_receivable_settlement_requests" ADD CONSTRAINT "person_receivable_settlement_requests_destination_asset_account_id_ledger_accounts_id_fk" FOREIGN KEY ("destination_asset_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_receivable_settlement_requests_user_idemp_idx" ON "person_receivable_settlement_requests" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "person_receivable_settlement_requests_user_person_idx" ON "person_receivable_settlement_requests" USING btree ("user_id","person_id");
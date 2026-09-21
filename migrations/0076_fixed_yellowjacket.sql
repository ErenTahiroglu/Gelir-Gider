CREATE TABLE "income_settlement_allocation_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"settlement_batch_id" uuid NOT NULL,
	"settlement_batch_revision_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"entitlement_id" uuid NOT NULL,
	"allocated_amount" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "income_settlement_allocation_rows" ADD CONSTRAINT "income_settlement_allocation_rows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_allocation_rows" ADD CONSTRAINT "income_settlement_allocation_rows_settlement_batch_id_income_settlement_batches_id_fk" FOREIGN KEY ("settlement_batch_id") REFERENCES "public"."income_settlement_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_allocation_rows" ADD CONSTRAINT "income_settlement_allocation_rows_settlement_batch_revision_id_income_settlement_batch_revisions_id_fk" FOREIGN KEY ("settlement_batch_revision_id") REFERENCES "public"."income_settlement_batch_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_allocation_rows" ADD CONSTRAINT "income_settlement_allocation_rows_entitlement_id_income_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."income_entitlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_income_settlement_alloc_rows_user_entitlement" ON "income_settlement_allocation_rows" USING btree ("user_id","entitlement_id","settlement_batch_id","revision_no");--> statement-breakpoint
CREATE INDEX "idx_income_settlement_alloc_rows_revision" ON "income_settlement_allocation_rows" USING btree ("settlement_batch_revision_id");--> statement-breakpoint
-- Backfill normalized allocation rows from existing income_settlement_batch_revisions
INSERT INTO "income_settlement_allocation_rows" (
	"id",
	"user_id",
	"settlement_batch_id",
	"settlement_batch_revision_id",
	"revision_no",
	"entitlement_id",
	"allocated_amount",
	"created_at"
)
SELECT
	gen_random_uuid(),
	isbr.user_id,
	isbr.settlement_batch_id,
	isbr.id,
	isbr.revision_no,
	(elem->>'entitlementId')::uuid,
	(elem->>'amount')::numeric,
	isbr.created_at
FROM income_settlement_batch_revisions isbr,
jsonb_array_elements(isbr.allocations) elem;
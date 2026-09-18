ALTER TABLE "income_settlement_batch_revisions" ADD COLUMN "receipt_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "income_settlement_batch_revisions" ADD COLUMN "snapshot_allocations" jsonb;--> statement-breakpoint
ALTER TABLE "month_close_adjustments" ADD COLUMN "remaining_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "month_close_adjustments_user_source_ref_idx" ON "month_close_adjustments" USING btree ("user_id","source_ref");
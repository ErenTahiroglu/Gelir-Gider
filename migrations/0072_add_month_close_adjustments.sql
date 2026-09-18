CREATE TABLE "month_close_adjustment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month_close_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"applied_amount" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "month_close_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"closed_period_month" date NOT NULL,
	"adjustment_amount" numeric(18, 2) NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"source_ref" varchar(128) NOT NULL,
	"applied_in_month_close_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_close_adjustments_closed_period_check" CHECK (EXTRACT(DAY FROM "month_close_adjustments"."closed_period_month") = 1),
	CONSTRAINT "month_close_adjustments_reason_code_check" CHECK ("month_close_adjustments"."reason_code" = btrim("month_close_adjustments"."reason_code") AND length("month_close_adjustments"."reason_code") BETWEEN 1 AND 64),
	CONSTRAINT "month_close_adjustments_source_ref_check" CHECK ("month_close_adjustments"."source_ref" = btrim("month_close_adjustments"."source_ref") AND length("month_close_adjustments"."source_ref") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "month_close_revisions" DROP CONSTRAINT "month_close_revisions_unrouted_check";--> statement-breakpoint
ALTER TABLE "month_close_revisions" DROP CONSTRAINT "month_close_revisions_shape_check";--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD COLUMN "unapplied_prior_adjustments" numeric(18, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD COLUMN "adjusted_routable_surplus" numeric(18, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "month_close_adjustment_applications" ADD CONSTRAINT "month_close_adjustment_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_adjustment_applications" ADD CONSTRAINT "month_close_adjustment_applications_month_close_id_month_closes_id_fk" FOREIGN KEY ("month_close_id") REFERENCES "public"."month_closes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_adjustment_applications" ADD CONSTRAINT "month_close_adjustment_applications_adjustment_id_month_close_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."month_close_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_adjustments" ADD CONSTRAINT "month_close_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_adjustments" ADD CONSTRAINT "month_close_adjustments_applied_in_month_close_id_month_closes_id_fk" FOREIGN KEY ("applied_in_month_close_id") REFERENCES "public"."month_closes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "month_close_adj_apps_unique_idx" ON "month_close_adjustment_applications" USING btree ("month_close_id","adjustment_id");--> statement-breakpoint
CREATE INDEX "month_close_adj_apps_user_idx" ON "month_close_adjustment_applications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "month_close_adjustments_user_unapplied_idx" ON "month_close_adjustments" USING btree ("user_id","closed_period_month");--> statement-breakpoint
CREATE INDEX "month_close_adjustments_applied_close_idx" ON "month_close_adjustments" USING btree ("applied_in_month_close_id");--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_adjusted_routable_check" CHECK ("month_close_revisions"."adjusted_routable_surplus" >= 0 AND "month_close_revisions"."adjusted_routable_surplus" = GREATEST("month_close_revisions"."close_surplus" + "month_close_revisions"."unapplied_prior_adjustments", 0));--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_unrouted_check" CHECK ("month_close_revisions"."unrouted_amount" = "month_close_revisions"."adjusted_routable_surplus" - "month_close_revisions"."applied_amount");--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_shape_check" CHECK (
				("month_close_revisions"."route" = 'SHORT_TERM_GOAL' AND "month_close_revisions"."decision" = 'FULL' AND "month_close_revisions"."applied_amount" = "month_close_revisions"."full_offer_amount" AND "month_close_revisions"."midas_allocation_transfer_id" IS NOT NULL)
				OR ("month_close_revisions"."route" = 'SHORT_TERM_GOAL' AND "month_close_revisions"."decision" = 'PARTIAL' AND "month_close_revisions"."applied_amount" > 0 AND "month_close_revisions"."applied_amount" < "month_close_revisions"."full_offer_amount" AND "month_close_revisions"."midas_allocation_transfer_id" IS NOT NULL)
				OR ("month_close_revisions"."route" = 'SHORT_TERM_GOAL' AND "month_close_revisions"."decision" = 'SKIP' AND "month_close_revisions"."applied_amount" = 0 AND "month_close_revisions"."midas_allocation_transfer_id" IS NULL)
				OR ("month_close_revisions"."route" = 'MEDIUM_TERM_RESERVE' AND "month_close_revisions"."decision" = 'AUTO_MEDIUM' AND "month_close_revisions"."applied_amount" = "month_close_revisions"."adjusted_routable_surplus" AND (("month_close_revisions"."adjusted_routable_surplus" > 0 AND "month_close_revisions"."midas_allocation_transfer_id" IS NOT NULL) OR ("month_close_revisions"."adjusted_routable_surplus" = 0 AND "month_close_revisions"."midas_allocation_transfer_id" IS NULL)))
				OR ("month_close_revisions"."route" = 'NONE' AND "month_close_revisions"."decision" = 'NO_ACTION' AND "month_close_revisions"."adjusted_routable_surplus" = 0 AND "month_close_revisions"."applied_amount" = 0 AND "month_close_revisions"."midas_allocation_transfer_id" IS NULL)
			);

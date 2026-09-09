CREATE TABLE "budget_v2_spending_food_semantic_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject_type" varchar(32) NOT NULL,
	"purchase_event_id" uuid,
	"person_obligation_id" uuid,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"basis_personal_amount" numeric(18, 2) NOT NULL,
	"food_home_market_amount" numeric(18, 2) NOT NULL,
	"food_outside_amount" numeric(18, 2) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"purchase_event_revision_id" uuid,
	"person_obligation_revision_id" uuid,
	"split_basis" varchar(24),
	"split_revision_id" uuid,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bv2food_rev_no_check" CHECK ("budget_v2_spending_food_semantic_revisions"."revision_no" > 0),
	CONSTRAINT "bv2food_op_check" CHECK ("budget_v2_spending_food_semantic_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "bv2food_subject_type_check" CHECK ("budget_v2_spending_food_semantic_revisions"."subject_type" IN ('CREDIT_CARD_PURCHASE', 'PEOPLE_PAYABLE')),
	CONSTRAINT "bv2food_source_kind_check" CHECK ("budget_v2_spending_food_semantic_revisions"."source_kind" IN ('USER_APPROVED', 'USER_APPROVED_FROM_SUGGESTION')),
	CONSTRAINT "bv2food_fingerprint_check" CHECK ("budget_v2_spending_food_semantic_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bv2food_idempotency_check" CHECK ("budget_v2_spending_food_semantic_revisions"."idempotency_key" = btrim("budget_v2_spending_food_semantic_revisions"."idempotency_key") AND length("budget_v2_spending_food_semantic_revisions"."idempotency_key") BETWEEN 1 AND 128),
	CONSTRAINT "bv2food_home_nonneg_check" CHECK ("budget_v2_spending_food_semantic_revisions"."food_home_market_amount" >= 0),
	CONSTRAINT "bv2food_outside_nonneg_check" CHECK ("budget_v2_spending_food_semantic_revisions"."food_outside_amount" >= 0),
	CONSTRAINT "bv2food_basis_positive_check" CHECK ("budget_v2_spending_food_semantic_revisions"."basis_personal_amount" > 0),
	CONSTRAINT "bv2food_food_sum_check" CHECK ("budget_v2_spending_food_semantic_revisions"."food_home_market_amount" + "budget_v2_spending_food_semantic_revisions"."food_outside_amount" <= "budget_v2_spending_food_semantic_revisions"."basis_personal_amount"),
	CONSTRAINT "bv2food_void_zero_food_check" CHECK ("budget_v2_spending_food_semantic_revisions"."operation" <> 'VOID' OR ("budget_v2_spending_food_semantic_revisions"."food_home_market_amount" = 0 AND "budget_v2_spending_food_semantic_revisions"."food_outside_amount" = 0)),
	CONSTRAINT "bv2food_subject_identity_check" CHECK (("budget_v2_spending_food_semantic_revisions"."subject_type" = 'CREDIT_CARD_PURCHASE' AND "budget_v2_spending_food_semantic_revisions"."purchase_event_id" IS NOT NULL AND "budget_v2_spending_food_semantic_revisions"."person_obligation_id" IS NULL AND "budget_v2_spending_food_semantic_revisions"."person_obligation_revision_id" IS NULL) OR ("budget_v2_spending_food_semantic_revisions"."subject_type" = 'PEOPLE_PAYABLE' AND "budget_v2_spending_food_semantic_revisions"."person_obligation_id" IS NOT NULL AND "budget_v2_spending_food_semantic_revisions"."purchase_event_id" IS NULL AND "budget_v2_spending_food_semantic_revisions"."purchase_event_revision_id" IS NULL AND "budget_v2_spending_food_semantic_revisions"."split_basis" IS NULL AND "budget_v2_spending_food_semantic_revisions"."split_revision_id" IS NULL)),
	CONSTRAINT "bv2food_split_basis_check" CHECK ("budget_v2_spending_food_semantic_revisions"."split_basis" IS NULL OR "budget_v2_spending_food_semantic_revisions"."split_basis" IN ('NO_SPLIT', 'VOID_SPLIT', 'SEALED_SPLIT_AS_OF')),
	CONSTRAINT "bv2food_sealed_split_rev_check" CHECK ("budget_v2_spending_food_semantic_revisions"."split_basis" <> 'SEALED_SPLIT_AS_OF' OR "budget_v2_spending_food_semantic_revisions"."split_revision_id" IS NOT NULL),
	CONSTRAINT "bv2food_cc_evidence_check" CHECK ("budget_v2_spending_food_semantic_revisions"."subject_type" <> 'CREDIT_CARD_PURCHASE' OR ("budget_v2_spending_food_semantic_revisions"."purchase_event_revision_id" IS NOT NULL AND "budget_v2_spending_food_semantic_revisions"."split_basis" IS NOT NULL)),
	CONSTRAINT "bv2food_people_evidence_check" CHECK ("budget_v2_spending_food_semantic_revisions"."subject_type" <> 'PEOPLE_PAYABLE' OR "budget_v2_spending_food_semantic_revisions"."person_obligation_revision_id" IS NOT NULL),
	CONSTRAINT "bv2food_create_chain_check" CHECK ("budget_v2_spending_food_semantic_revisions"."revision_no" <> 1 OR ("budget_v2_spending_food_semantic_revisions"."previous_revision_id" IS NULL AND "budget_v2_spending_food_semantic_revisions"."operation" = 'CREATE')),
	CONSTRAINT "bv2food_noncreate_chain_check" CHECK ("budget_v2_spending_food_semantic_revisions"."revision_no" = 1 OR ("budget_v2_spending_food_semantic_revisions"."previous_revision_id" IS NOT NULL AND "budget_v2_spending_food_semantic_revisions"."operation" IN ('UPDATE', 'VOID')))
);
--> statement-breakpoint
ALTER TABLE "budget_v2_spending_food_semantic_revisions" ADD CONSTRAINT "budget_v2_spending_food_semantic_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_spending_food_semantic_revisions" ADD CONSTRAINT "budget_v2_spending_food_semantic_revisions_purchase_event_id_credit_card_liability_events_id_fk" FOREIGN KEY ("purchase_event_id") REFERENCES "public"."credit_card_liability_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_spending_food_semantic_revisions" ADD CONSTRAINT "budget_v2_spending_food_semantic_revisions_person_obligation_id_person_obligations_id_fk" FOREIGN KEY ("person_obligation_id") REFERENCES "public"."person_obligations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_spending_food_semantic_revisions" ADD CONSTRAINT "budget_v2_spending_food_semantic_revisions_previous_revision_id_budget_v2_spending_food_semantic_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."budget_v2_spending_food_semantic_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_spending_food_semantic_revisions" ADD CONSTRAINT "budget_v2_spending_food_semantic_revisions_purchase_event_revision_id_credit_card_liability_event_revisions_id_fk" FOREIGN KEY ("purchase_event_revision_id") REFERENCES "public"."credit_card_liability_event_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_spending_food_semantic_revisions" ADD CONSTRAINT "budget_v2_spending_food_semantic_revisions_person_obligation_revision_id_person_obligation_revisions_id_fk" FOREIGN KEY ("person_obligation_revision_id") REFERENCES "public"."person_obligation_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_spending_food_semantic_revisions" ADD CONSTRAINT "budget_v2_spending_food_semantic_revisions_split_revision_id_credit_card_purchase_split_revisions_id_fk" FOREIGN KEY ("split_revision_id") REFERENCES "public"."credit_card_purchase_split_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2food_purchase_rev_no_idx" ON "budget_v2_spending_food_semantic_revisions" USING btree ("purchase_event_id","revision_no") WHERE "budget_v2_spending_food_semantic_revisions"."purchase_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2food_obligation_rev_no_idx" ON "budget_v2_spending_food_semantic_revisions" USING btree ("person_obligation_id","revision_no") WHERE "budget_v2_spending_food_semantic_revisions"."person_obligation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2food_prev_idx" ON "budget_v2_spending_food_semantic_revisions" USING btree ("previous_revision_id") WHERE "budget_v2_spending_food_semantic_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2food_user_idempotency_idx" ON "budget_v2_spending_food_semantic_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bv2food_user_purchase_idx" ON "budget_v2_spending_food_semantic_revisions" USING btree ("user_id","purchase_event_id");--> statement-breakpoint
CREATE INDEX "bv2food_user_obligation_idx" ON "budget_v2_spending_food_semantic_revisions" USING btree ("user_id","person_obligation_id");--> statement-breakpoint

-- ============================================================================
-- 0067 (custom): BUDGET V2 EXPLICIT SPENDING FOOD SEMANTICS
--
-- Forward-only. One additive append-only metadata projection:
--   budget_v2_spending_food_semantic_revisions
--     -- explicit user-approved FOOD_HOME_MARKET / FOOD_OUTSIDE allocation of a
--        personal economic spending amount (a credit-card purchase's personal
--        share, or a People PAYABLE obligation principal).
--
-- NOT an economic event: NO canonical transaction, NO ledger posting, NO Midas
-- movement, NO statement-liability change, NO People-principal change. No
-- merchant / MCC / behaviour inference anywhere (least of all in SQL). No
-- historical backfill, no auto-classification, no NON_FOOD rows created
-- implicitly. No UPDATE of Income / People / Credit-card / Midas records.
--
-- Gets a UPDATE/DELETE immutability guard + a BEFORE INSERT guard that binds
-- ownership + subject validity (CREDIT_CARD_PURCHASE -> a PURCHASE liability
-- event owned by the user; PEOPLE_PAYABLE -> a PAYABLE obligation owned by the
-- user) and enforces the append-only, unbranched CREATE(1) -> UPDATE/VOID(n)
-- revision chain.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2food_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'budget_v2_spending_food_semantic_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2food_revisions_immutability ON "budget_v2_spending_food_semantic_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2food_revisions_immutability
BEFORE UPDATE OR DELETE ON "budget_v2_spending_food_semantic_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2food_revisions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2food_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_event RECORD;
  v_obl RECORD;
  v_prev RECORD;
BEGIN
  -- 1. Lock + validate the polymorphic financial subject.
  IF NEW.subject_type = 'CREDIT_CARD_PURCHASE' THEN
    IF NEW.purchase_event_id IS NULL OR NEW.person_obligation_id IS NOT NULL THEN
      RAISE EXCEPTION 'CREDIT_CARD_PURCHASE food classification requires purchase_event_id and no person_obligation_id';
    END IF;
    SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.purchase_event_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit_card_liability_events row % not found for food classification', NEW.purchase_event_id;
    END IF;
    IF v_event.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'credit_card_liability_events user_id % does not match food classification user_id %', v_event.user_id, NEW.user_id;
    END IF;
    IF v_event.event_type != 'PURCHASE' THEN
      RAISE EXCEPTION 'food classification target credit_card_liability_events % is event_type %, expected PURCHASE', NEW.purchase_event_id, v_event.event_type;
    END IF;
  ELSIF NEW.subject_type = 'PEOPLE_PAYABLE' THEN
    IF NEW.person_obligation_id IS NULL OR NEW.purchase_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'PEOPLE_PAYABLE food classification requires person_obligation_id and no purchase_event_id';
    END IF;
    SELECT * INTO v_obl FROM person_obligations WHERE id = NEW.person_obligation_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'person_obligations row % not found for food classification', NEW.person_obligation_id;
    END IF;
    IF v_obl.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'person_obligations user_id % does not match food classification user_id %', v_obl.user_id, NEW.user_id;
    END IF;
    IF v_obl.direction != 'PAYABLE' THEN
      RAISE EXCEPTION 'food classification target person_obligations % is direction %, expected PAYABLE', NEW.person_obligation_id, v_obl.direction;
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown food classification subject_type %', NEW.subject_type;
  END IF;

  -- 2. Append-only, unbranched CREATE(1) -> UPDATE/VOID(n) chain.
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First food classification revision must have NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First food classification revision must have operation CREATE';
    END IF;
  ELSE
    IF NEW.previous_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent food classification revision must have non-NULL previous_revision_id';
    END IF;
    IF NEW.operation NOT IN ('UPDATE', 'VOID') THEN
      RAISE EXCEPTION 'Subsequent food classification revision must have operation UPDATE or VOID';
    END IF;
    SELECT * INTO v_prev FROM budget_v2_spending_food_semantic_revisions WHERE id = NEW.previous_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous food classification revision % not found', NEW.previous_revision_id;
    END IF;
    IF v_prev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous food classification revision user_id % does not match %', v_prev.user_id, NEW.user_id;
    END IF;
    IF v_prev.subject_type != NEW.subject_type
       OR v_prev.purchase_event_id IS DISTINCT FROM NEW.purchase_event_id
       OR v_prev.person_obligation_id IS DISTINCT FROM NEW.person_obligation_id THEN
      RAISE EXCEPTION 'previous food classification revision subject does not match %', NEW.previous_revision_id;
    END IF;
    IF v_prev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous food classification revision_no % must be exactly %', v_prev.revision_no, NEW.revision_no - 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2food_revisions_insert ON "budget_v2_spending_food_semantic_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2food_revisions_insert
BEFORE INSERT ON "budget_v2_spending_food_semantic_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2food_revisions_insert();

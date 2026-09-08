CREATE TABLE "credit_card_statement_reconciliation_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_revision_id" uuid NOT NULL,
	"component_no" integer NOT NULL,
	"component_type" varchar(12) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"ownership" varchar(16) NOT NULL,
	"person_id" uuid,
	"purchase_event_id" uuid,
	"purchase_split_revision_id" uuid,
	"adjustment_kind" varchar(16),
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccsrc_component_no_check" CHECK ("credit_card_statement_reconciliation_components"."component_no" > 0),
	CONSTRAINT "ccsrc_type_check" CHECK ("credit_card_statement_reconciliation_components"."component_type" IN ('PURCHASE', 'ADJUSTMENT')),
	CONSTRAINT "ccsrc_amount_check" CHECK ("credit_card_statement_reconciliation_components"."amount" > 0),
	CONSTRAINT "ccsrc_ownership_check" CHECK ("credit_card_statement_reconciliation_components"."ownership" IN ('PERSONAL', 'EXTERNAL_PERSON')),
	CONSTRAINT "ccsrc_ownership_person_consistency_check" CHECK (("credit_card_statement_reconciliation_components"."ownership" = 'EXTERNAL_PERSON' AND "credit_card_statement_reconciliation_components"."person_id" IS NOT NULL) OR ("credit_card_statement_reconciliation_components"."ownership" = 'PERSONAL' AND "credit_card_statement_reconciliation_components"."person_id" IS NULL)),
	CONSTRAINT "ccsrc_type_reference_consistency_check" CHECK (("credit_card_statement_reconciliation_components"."component_type" = 'PURCHASE' AND "credit_card_statement_reconciliation_components"."purchase_event_id" IS NOT NULL AND "credit_card_statement_reconciliation_components"."adjustment_kind" IS NULL) OR ("credit_card_statement_reconciliation_components"."component_type" = 'ADJUSTMENT' AND "credit_card_statement_reconciliation_components"."purchase_event_id" IS NULL AND "credit_card_statement_reconciliation_components"."purchase_split_revision_id" IS NULL AND "credit_card_statement_reconciliation_components"."adjustment_kind" IS NOT NULL)),
	CONSTRAINT "ccsrc_adjustment_kind_check" CHECK ("credit_card_statement_reconciliation_components"."adjustment_kind" IS NULL OR "credit_card_statement_reconciliation_components"."adjustment_kind" IN ('FEE', 'INTEREST', 'CARRY_OVER', 'FX_ADJUSTMENT', 'OTHER')),
	CONSTRAINT "ccsrc_note_check" CHECK ("credit_card_statement_reconciliation_components"."note" IS NULL OR ("credit_card_statement_reconciliation_components"."note" = btrim("credit_card_statement_reconciliation_components"."note") AND length("credit_card_statement_reconciliation_components"."note") BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE TABLE "credit_card_statement_reconciliation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(12) NOT NULL,
	"statement_revision_id" uuid NOT NULL,
	"reconciled_statement_amount" numeric(18, 2) NOT NULL,
	"component_count" integer NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"reconciliation_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccsrr_rev_no_check" CHECK ("credit_card_statement_reconciliation_revisions"."revision_no" > 0),
	CONSTRAINT "ccsrr_op_check" CHECK ("credit_card_statement_reconciliation_revisions"."operation" IN ('CREATE', 'SUPERSEDE', 'VOID')),
	CONSTRAINT "ccsrr_amount_check" CHECK ("credit_card_statement_reconciliation_revisions"."reconciled_statement_amount" > 0),
	CONSTRAINT "ccsrr_component_count_check" CHECK ("credit_card_statement_reconciliation_revisions"."component_count" >= 0),
	CONSTRAINT "ccsrr_fingerprint_check" CHECK ("credit_card_statement_reconciliation_revisions"."reconciliation_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ccsrr_idempotency_check" CHECK ("credit_card_statement_reconciliation_revisions"."idempotency_key" = btrim("credit_card_statement_reconciliation_revisions"."idempotency_key") AND length("credit_card_statement_reconciliation_revisions"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "credit_card_statement_reconciliation_seals" (
	"reconciliation_revision_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_card_statement_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"credit_card_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_components" ADD CONSTRAINT "credit_card_statement_reconciliation_components_reconciliation_revision_id_credit_card_statement_reconciliation_revisions_id_fk" FOREIGN KEY ("reconciliation_revision_id") REFERENCES "public"."credit_card_statement_reconciliation_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_components" ADD CONSTRAINT "credit_card_statement_reconciliation_components_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_components" ADD CONSTRAINT "credit_card_statement_reconciliation_components_purchase_event_id_credit_card_liability_events_id_fk" FOREIGN KEY ("purchase_event_id") REFERENCES "public"."credit_card_liability_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_components" ADD CONSTRAINT "credit_card_statement_reconciliation_components_purchase_split_revision_id_credit_card_purchase_split_revisions_id_fk" FOREIGN KEY ("purchase_split_revision_id") REFERENCES "public"."credit_card_purchase_split_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_revisions" ADD CONSTRAINT "credit_card_statement_reconciliation_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_revisions" ADD CONSTRAINT "credit_card_statement_reconciliation_revisions_reconciliation_id_credit_card_statement_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."credit_card_statement_reconciliations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_revisions" ADD CONSTRAINT "credit_card_statement_reconciliation_revisions_previous_revision_id_credit_card_statement_reconciliation_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."credit_card_statement_reconciliation_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_revisions" ADD CONSTRAINT "credit_card_statement_reconciliation_revisions_statement_revision_id_credit_card_statement_revisions_id_fk" FOREIGN KEY ("statement_revision_id") REFERENCES "public"."credit_card_statement_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliation_seals" ADD CONSTRAINT "credit_card_statement_reconciliation_seals_reconciliation_revision_id_credit_card_statement_reconciliation_revisions_id_fk" FOREIGN KEY ("reconciliation_revision_id") REFERENCES "public"."credit_card_statement_reconciliation_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliations" ADD CONSTRAINT "credit_card_statement_reconciliations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliations" ADD CONSTRAINT "credit_card_statement_reconciliations_statement_id_credit_card_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."credit_card_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_reconciliations" ADD CONSTRAINT "credit_card_statement_reconciliations_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ccsrc_rev_component_no_idx" ON "credit_card_statement_reconciliation_components" USING btree ("reconciliation_revision_id","component_no");--> statement-breakpoint
CREATE INDEX "ccsrc_rev_idx" ON "credit_card_statement_reconciliation_components" USING btree ("reconciliation_revision_id");--> statement-breakpoint
CREATE INDEX "ccsrc_purchase_event_idx" ON "credit_card_statement_reconciliation_components" USING btree ("purchase_event_id");--> statement-breakpoint
CREATE INDEX "ccsrc_person_idx" ON "credit_card_statement_reconciliation_components" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ccsrr_recon_rev_no_idx" ON "credit_card_statement_reconciliation_revisions" USING btree ("reconciliation_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "ccsrr_prev_idx" ON "credit_card_statement_reconciliation_revisions" USING btree ("previous_revision_id") WHERE "credit_card_statement_reconciliation_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ccsrr_user_idempotency_idx" ON "credit_card_statement_reconciliation_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ccsrr_recon_idx" ON "credit_card_statement_reconciliation_revisions" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE INDEX "ccsrr_stmt_rev_idx" ON "credit_card_statement_reconciliation_revisions" USING btree ("statement_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ccsr_statement_idx" ON "credit_card_statement_reconciliations" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "ccsr_user_idx" ON "credit_card_statement_reconciliations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ccsr_card_idx" ON "credit_card_statement_reconciliations" USING btree ("credit_card_id");

-- ============================================================================
-- 0065 (custom): CREDIT-CARD STATEMENT RECONCILIATION INTEGRITY
--
-- Forward-only. Four additive append-only tables that make a credit-card
-- statement's personal / external composition EXPLICIT and AUTHORITATIVE
-- (never calendar-inferred). NO canonical transaction, NO ledger posting, NO
-- Midas movement, NO financial-row backfill, NO UPDATE of Income / People /
-- Midas / Goal / Card records, NO V1 Budget DDL.
--
-- Guards:
--   * UPDATE/DELETE immutability on all four tables
--   * anchor insert  -- statement ownership + card binding
--   * revision insert -- append-only CREATE(1)->(SUPERSEDE|VOID)(n) chain, no
--                        revision after a VOID, statement-revision binding,
--                        reconciled_statement_amount == statement_amount,
--                        component_count parity with the operation
--   * component insert -- parent not sealed / not VOID, PURCHASE backed by a
--                         non-VOID purchase liability event on the anchor card,
--                         optional split-revision belongs to that purchase,
--                         EXTERNAL_PERSON person owned by the user
--   * seal insert -- kurus-exact  SUM(component.amount) == reconciled_statement_amount
--                    and component count parity; VOID revisions are never sealed
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_ccsr_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_card_statement_reconciliation* rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsr_immutability ON "credit_card_statement_reconciliations";--> statement-breakpoint
CREATE TRIGGER trg_guard_ccsr_immutability
BEFORE UPDATE OR DELETE ON "credit_card_statement_reconciliations"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsr_immutability();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsrr_immutability ON "credit_card_statement_reconciliation_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_ccsrr_immutability
BEFORE UPDATE OR DELETE ON "credit_card_statement_reconciliation_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsr_immutability();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsrc_immutability ON "credit_card_statement_reconciliation_components";--> statement-breakpoint
CREATE TRIGGER trg_guard_ccsrc_immutability
BEFORE UPDATE OR DELETE ON "credit_card_statement_reconciliation_components"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsr_immutability();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsr_seal_immutability ON "credit_card_statement_reconciliation_seals";--> statement-breakpoint
CREATE TRIGGER trg_guard_ccsr_seal_immutability
BEFORE UPDATE OR DELETE ON "credit_card_statement_reconciliation_seals"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsr_immutability();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Anchor insert guard
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_guard_ccsr_anchor_insert()
RETURNS trigger AS $$
DECLARE
  v_stmt RECORD;
BEGIN
  SELECT * INTO v_stmt FROM credit_card_statements WHERE id = NEW.statement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statements row % not found for reconciliation anchor', NEW.statement_id;
  END IF;
  IF v_stmt.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'statement user_id % does not match reconciliation user_id %', v_stmt.user_id, NEW.user_id;
  END IF;
  IF v_stmt.credit_card_id != NEW.credit_card_id THEN
    RAISE EXCEPTION 'reconciliation credit_card_id % does not match statement credit_card_id %', NEW.credit_card_id, v_stmt.credit_card_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsr_anchor_insert ON "credit_card_statement_reconciliations";--> statement-breakpoint
CREATE TRIGGER trg_guard_ccsr_anchor_insert
BEFORE INSERT ON "credit_card_statement_reconciliations"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsr_anchor_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Revision insert guard
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_guard_ccsrr_insert()
RETURNS trigger AS $$
DECLARE
  v_recon RECORD;
  v_stmt_rev RECORD;
  v_prev RECORD;
BEGIN
  SELECT * INTO v_recon FROM credit_card_statement_reconciliations WHERE id = NEW.reconciliation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statement_reconciliations row % not found', NEW.reconciliation_id;
  END IF;
  IF v_recon.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'reconciliation user_id % does not match revision user_id %', v_recon.user_id, NEW.user_id;
  END IF;

  -- Statement-revision binding: it must belong to this reconciliation's
  -- statement and reproduce its exact statement_amount.
  SELECT * INTO v_stmt_rev FROM credit_card_statement_revisions WHERE id = NEW.statement_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statement_revisions row % not found', NEW.statement_revision_id;
  END IF;
  IF v_stmt_rev.statement_id != v_recon.statement_id THEN
    RAISE EXCEPTION 'statement_revision % belongs to statement % not reconciliation statement %', NEW.statement_revision_id, v_stmt_rev.statement_id, v_recon.statement_id;
  END IF;
  IF v_stmt_rev.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'statement_revision user_id % does not match revision user_id %', v_stmt_rev.user_id, NEW.user_id;
  END IF;
  IF v_stmt_rev.statement_amount != NEW.reconciled_statement_amount THEN
    RAISE EXCEPTION 'reconciled_statement_amount % does not match statement_revision statement_amount %', NEW.reconciled_statement_amount, v_stmt_rev.statement_amount;
  END IF;

  -- Append-only, unbranched CREATE(1) -> (SUPERSEDE|VOID)(n) chain.
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First reconciliation revision must have NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First reconciliation revision must have operation CREATE';
    END IF;
  ELSE
    IF NEW.previous_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent reconciliation revision must have non-NULL previous_revision_id';
    END IF;
    IF NEW.operation NOT IN ('SUPERSEDE', 'VOID') THEN
      RAISE EXCEPTION 'Subsequent reconciliation revision operation must be SUPERSEDE or VOID';
    END IF;
    SELECT * INTO v_prev FROM credit_card_statement_reconciliation_revisions WHERE id = NEW.previous_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous reconciliation revision % not found', NEW.previous_revision_id;
    END IF;
    IF v_prev.reconciliation_id != NEW.reconciliation_id THEN
      RAISE EXCEPTION 'previous reconciliation revision reconciliation_id % does not match %', v_prev.reconciliation_id, NEW.reconciliation_id;
    END IF;
    IF v_prev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous reconciliation revision user_id % does not match %', v_prev.user_id, NEW.user_id;
    END IF;
    IF v_prev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous reconciliation revision_no % must be exactly %', v_prev.revision_no, NEW.revision_no - 1;
    END IF;
    IF v_prev.operation = 'VOID' THEN
      RAISE EXCEPTION 'no reconciliation revision may be appended after a VOID revision';
    END IF;
  END IF;

  -- Component-count parity with the operation.
  IF NEW.operation = 'VOID' THEN
    IF NEW.component_count != 0 THEN
      RAISE EXCEPTION 'VOID reconciliation revision must declare component_count 0, got %', NEW.component_count;
    END IF;
  ELSE
    IF NEW.component_count < 1 THEN
      RAISE EXCEPTION '% reconciliation revision must declare component_count >= 1, got %', NEW.operation, NEW.component_count;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsrr_insert ON "credit_card_statement_reconciliation_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_ccsrr_insert
BEFORE INSERT ON "credit_card_statement_reconciliation_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsrr_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Component insert guard
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_guard_ccsrc_insert()
RETURNS trigger AS $$
DECLARE
  v_rev RECORD;
  v_recon RECORD;
  v_event RECORD;
  v_latest_event_rev RECORD;
  v_split RECORD;
  v_person RECORD;
BEGIN
  SELECT * INTO v_rev FROM credit_card_statement_reconciliation_revisions WHERE id = NEW.reconciliation_revision_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statement_reconciliation_revisions row % not found', NEW.reconciliation_revision_id;
  END IF;
  IF v_rev.operation = 'VOID' THEN
    RAISE EXCEPTION 'a VOID reconciliation revision carries no components';
  END IF;
  IF EXISTS (SELECT 1 FROM credit_card_statement_reconciliation_seals WHERE reconciliation_revision_id = NEW.reconciliation_revision_id) THEN
    RAISE EXCEPTION 'reconciliation revision % is sealed; no further components may be added', NEW.reconciliation_revision_id;
  END IF;

  SELECT * INTO v_recon FROM credit_card_statement_reconciliations WHERE id = v_rev.reconciliation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation anchor % not found for revision %', v_rev.reconciliation_id, NEW.reconciliation_revision_id;
  END IF;

  IF NEW.component_type = 'PURCHASE' THEN
    SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.purchase_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit_card_liability_events row % not found for PURCHASE component', NEW.purchase_event_id;
    END IF;
    IF v_event.event_type != 'PURCHASE' THEN
      RAISE EXCEPTION 'PURCHASE component must reference a PURCHASE liability event, got %', v_event.event_type;
    END IF;
    IF v_event.user_id != v_rev.user_id THEN
      RAISE EXCEPTION 'PURCHASE component liability event user_id % does not match reconciliation user_id %', v_event.user_id, v_rev.user_id;
    END IF;
    IF v_event.credit_card_id != v_recon.credit_card_id THEN
      RAISE EXCEPTION 'PURCHASE component liability event card % does not match reconciliation card %', v_event.credit_card_id, v_recon.credit_card_id;
    END IF;
    SELECT * INTO v_latest_event_rev
      FROM credit_card_liability_event_revisions
      WHERE event_id = NEW.purchase_event_id
      ORDER BY revision_no DESC
      LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'liability event % has no revisions', NEW.purchase_event_id;
    END IF;
    IF v_latest_event_rev.operation = 'VOID' THEN
      RAISE EXCEPTION 'PURCHASE component references a VOID purchase liability event %', NEW.purchase_event_id;
    END IF;
    IF NEW.purchase_split_revision_id IS NOT NULL THEN
      SELECT s.* INTO v_split
        FROM credit_card_purchase_split_revisions r
        JOIN credit_card_purchase_splits s ON s.id = r.split_id
        WHERE r.id = NEW.purchase_split_revision_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_card_purchase_split_revisions row % not found', NEW.purchase_split_revision_id;
      END IF;
      IF v_split.purchase_event_id != NEW.purchase_event_id THEN
        RAISE EXCEPTION 'split revision % belongs to purchase % not component purchase %', NEW.purchase_split_revision_id, v_split.purchase_event_id, NEW.purchase_event_id;
      END IF;
    END IF;
  END IF;

  IF NEW.ownership = 'EXTERNAL_PERSON' THEN
    SELECT * INTO v_person FROM people WHERE id = NEW.person_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'people row % not found for EXTERNAL_PERSON component', NEW.person_id;
    END IF;
    IF v_person.user_id != v_rev.user_id THEN
      RAISE EXCEPTION 'component person user_id % does not match reconciliation user_id %', v_person.user_id, v_rev.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsrc_insert ON "credit_card_statement_reconciliation_components";--> statement-breakpoint
CREATE TRIGGER trg_guard_ccsrc_insert
BEFORE INSERT ON "credit_card_statement_reconciliation_components"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsrc_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Seal insert guard -- kurus-exact component sum + count parity
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_guard_ccsr_seal_insert()
RETURNS trigger AS $$
DECLARE
  v_rev RECORD;
  v_sum numeric(18,2);
  v_count integer;
BEGIN
  SELECT * INTO v_rev FROM credit_card_statement_reconciliation_revisions WHERE id = NEW.reconciliation_revision_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statement_reconciliation_revisions row % not found for seal', NEW.reconciliation_revision_id;
  END IF;
  IF v_rev.operation NOT IN ('CREATE', 'SUPERSEDE') THEN
    RAISE EXCEPTION 'only CREATE / SUPERSEDE reconciliation revisions may be sealed, got %', v_rev.operation;
  END IF;

  SELECT COALESCE(SUM(amount), 0)::numeric(18,2), COUNT(*)::integer
    INTO v_sum, v_count
    FROM credit_card_statement_reconciliation_components
    WHERE reconciliation_revision_id = NEW.reconciliation_revision_id;

  IF v_count < 1 THEN
    RAISE EXCEPTION 'reconciliation revision % has no components to seal', NEW.reconciliation_revision_id;
  END IF;
  IF v_count != v_rev.component_count THEN
    RAISE EXCEPTION 'sealed component count % does not match declared component_count %', v_count, v_rev.component_count;
  END IF;
  IF v_sum != v_rev.reconciled_statement_amount THEN
    RAISE EXCEPTION 'reconciliation component sum % does not equal reconciled_statement_amount %', v_sum, v_rev.reconciled_statement_amount;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsr_seal_insert ON "credit_card_statement_reconciliation_seals";--> statement-breakpoint
CREATE TRIGGER trg_guard_ccsr_seal_insert
BEFORE INSERT ON "credit_card_statement_reconciliation_seals"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsr_seal_insert();

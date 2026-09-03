CREATE TABLE "income_entitlement_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entitlement_id" uuid NOT NULL,
	"canonical_revision_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_entitlement_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"expected_receipt_on" date,
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_entitlement_revisions_rev_no_check" CHECK ("income_entitlement_revisions"."revision_no" > 0),
	CONSTRAINT "income_entitlement_revisions_op_check" CHECK ("income_entitlement_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "income_entitlement_revisions_amount_check" CHECK ("income_entitlement_revisions"."amount" > 0),
	CONSTRAINT "income_entitlement_revisions_note_check" CHECK ("income_entitlement_revisions"."note" IS NULL OR ("income_entitlement_revisions"."note" = btrim("income_entitlement_revisions"."note") AND length("income_entitlement_revisions"."note") BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE TABLE "income_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_entitlements_period_month_check" CHECK (EXTRACT(DAY FROM "income_entitlements"."period_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "income_settlement_batch_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"settlement_batch_id" uuid NOT NULL,
	"canonical_revision_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_settlement_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"allocations" jsonb NOT NULL,
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_settlement_batch_revisions_rev_no_check" CHECK ("income_settlement_batch_revisions"."revision_no" > 0),
	CONSTRAINT "income_settlement_batch_revisions_op_check" CHECK ("income_settlement_batch_revisions"."operation" IN ('CREATE', 'UPDATE')),
	CONSTRAINT "income_settlement_batch_revisions_note_check" CHECK ("income_settlement_batch_revisions"."note" IS NULL OR ("income_settlement_batch_revisions"."note" = btrim("income_settlement_batch_revisions"."note") AND length("income_settlement_batch_revisions"."note") BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE TABLE "income_settlement_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"income_receipt_id" uuid NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "income_entitlement_revisions" ADD CONSTRAINT "income_entitlement_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entitlement_revisions" ADD CONSTRAINT "income_entitlement_revisions_entitlement_id_income_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."income_entitlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entitlement_revisions" ADD CONSTRAINT "income_entitlement_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entitlement_revisions" ADD CONSTRAINT "income_entitlement_revisions_previous_entitlement_revision_id_income_entitlement_revisions_id_fk" FOREIGN KEY ("previous_entitlement_revision_id") REFERENCES "public"."income_entitlement_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entitlements" ADD CONSTRAINT "income_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entitlements" ADD CONSTRAINT "income_entitlements_source_id_income_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."income_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entitlements" ADD CONSTRAINT "income_entitlements_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_batch_revisions" ADD CONSTRAINT "income_settlement_batch_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_batch_revisions" ADD CONSTRAINT "income_settlement_batch_revisions_settlement_batch_id_income_settlement_batches_id_fk" FOREIGN KEY ("settlement_batch_id") REFERENCES "public"."income_settlement_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_batch_revisions" ADD CONSTRAINT "income_settlement_batch_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_batch_revisions" ADD CONSTRAINT "income_settlement_batch_revisions_previous_settlement_revision_id_income_settlement_batch_revisions_id_fk" FOREIGN KEY ("previous_settlement_revision_id") REFERENCES "public"."income_settlement_batch_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_batches" ADD CONSTRAINT "income_settlement_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_batches" ADD CONSTRAINT "income_settlement_batches_income_receipt_id_income_receipts_id_fk" FOREIGN KEY ("income_receipt_id") REFERENCES "public"."income_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_settlement_batches" ADD CONSTRAINT "income_settlement_batches_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "income_entitlement_revisions_canonical_rev_idx" ON "income_entitlement_revisions" USING btree ("canonical_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_entitlement_revisions_entitlement_rev_no_idx" ON "income_entitlement_revisions" USING btree ("entitlement_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "income_entitlement_revisions_prev_idx" ON "income_entitlement_revisions" USING btree ("previous_entitlement_revision_id") WHERE "income_entitlement_revisions"."previous_entitlement_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "income_entitlement_revisions_user_entitlement_idx" ON "income_entitlement_revisions" USING btree ("user_id","entitlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_entitlements_user_source_period_idx" ON "income_entitlements" USING btree ("user_id","source_id","period_month");--> statement-breakpoint
CREATE UNIQUE INDEX "income_entitlements_canonical_tx_idx" ON "income_entitlements" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "income_entitlements_user_source_idx" ON "income_entitlements" USING btree ("user_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_settlement_batch_revisions_canonical_rev_idx" ON "income_settlement_batch_revisions" USING btree ("canonical_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_settlement_batch_revisions_batch_rev_no_idx" ON "income_settlement_batch_revisions" USING btree ("settlement_batch_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "income_settlement_batch_revisions_prev_idx" ON "income_settlement_batch_revisions" USING btree ("previous_settlement_revision_id") WHERE "income_settlement_batch_revisions"."previous_settlement_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "income_settlement_batch_revisions_user_batch_idx" ON "income_settlement_batch_revisions" USING btree ("user_id","settlement_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_settlement_batches_receipt_idx" ON "income_settlement_batches" USING btree ("income_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_settlement_batches_canonical_tx_idx" ON "income_settlement_batches" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "income_settlement_batches_user_idx" ON "income_settlement_batches" USING btree ("user_id");--> statement-breakpoint

-- ============================================================================
-- IMMUTABILITY GUARDS (income_entitlements & income_settlement_batches)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_income_entitlements_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'income_entitlements rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_income_entitlements_immutability
BEFORE UPDATE OR DELETE ON income_entitlements
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_income_entitlements_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_income_entitlement_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'income_entitlement_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_income_entitlement_revisions_immutability
BEFORE UPDATE OR DELETE ON income_entitlement_revisions
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_income_entitlement_revisions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_income_settlement_batches_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'income_settlement_batches rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_income_settlement_batches_immutability
BEFORE UPDATE OR DELETE ON income_settlement_batches
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_income_settlement_batches_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_income_settlement_batch_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'income_settlement_batch_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_income_settlement_batch_revisions_immutability
BEFORE UPDATE OR DELETE ON income_settlement_batch_revisions
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_income_settlement_batch_revisions_immutability();--> statement-breakpoint

-- ============================================================================
-- HARDENED TRIGGER: income_entitlement_revisions insert
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_income_entitlement_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_entitlement RECORD;
  v_source RECORD;
  v_canon_tx RECORD;
  v_rev RECORD;
  v_prev_ent_rev RECORD;
BEGIN
  -- 1. Validate entitlement identity exists and belongs to user
  SELECT * INTO v_entitlement
  FROM income_entitlements
  WHERE id = NEW.entitlement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_entitlements row % not found', NEW.entitlement_id;
  END IF;

  IF v_entitlement.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_entitlement user_id % does not match revision user_id %',
      v_entitlement.user_id, NEW.user_id;
  END IF;

  -- 2. Validate income source exists and has nature = 'REGULAR'
  SELECT * INTO v_source
  FROM income_sources
  WHERE id = v_entitlement.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_sources row % not found', v_entitlement.source_id;
  END IF;

  IF v_source.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_sources user_id % does not match entitlement user_id %',
      v_source.user_id, NEW.user_id;
  END IF;

  IF v_source.nature != 'REGULAR' THEN
    RAISE EXCEPTION 'Entitlements are only permitted for REGULAR income sources, found %',
      v_source.nature;
  END IF;

  -- 3. Validate canonical transaction
  SELECT * INTO v_canon_tx
  FROM canonical_transactions
  WHERE id = v_entitlement.canonical_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical_transactions row % not found', v_entitlement.canonical_transaction_id;
  END IF;

  IF v_canon_tx.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_transaction user_id % does not match revision user_id %',
      v_canon_tx.user_id, NEW.user_id;
  END IF;

  IF v_canon_tx.kind != 'INCOME_ENTITLEMENT' THEN
    RAISE EXCEPTION 'canonical_transaction kind must be INCOME_ENTITLEMENT, found %',
      v_canon_tx.kind;
  END IF;

  -- 4. Validate canonical revision
  SELECT * INTO v_rev
  FROM transaction_revisions
  WHERE id = NEW.canonical_revision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_revisions row % not found', NEW.canonical_revision_id;
  END IF;

  IF v_rev.transaction_id != v_entitlement.canonical_transaction_id THEN
    RAISE EXCEPTION 'canonical_revision transaction_id % does not match entitlement canonical_transaction_id %',
      v_rev.transaction_id, v_entitlement.canonical_transaction_id;
  END IF;

  IF v_rev.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_revision user_id % does not match revision user_id %',
      v_rev.user_id, NEW.user_id;
  END IF;

  IF v_rev.revision_no != NEW.revision_no THEN
    RAISE EXCEPTION 'canonical_revision revision_no % does not match revision_no %',
      v_rev.revision_no, NEW.revision_no;
  END IF;

  IF v_rev.operation != NEW.operation THEN
    RAISE EXCEPTION 'canonical_revision operation % does not match revision operation %',
      v_rev.operation, NEW.operation;
  END IF;

  -- 5. Revision chain validation
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_entitlement_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First entitlement revision must have NULL previous_entitlement_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First entitlement revision must have operation CREATE';
    END IF;
    IF v_rev.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First canonical revision must have NULL previous_revision_id';
    END IF;
  ELSE
    IF NEW.previous_entitlement_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent entitlement revision must have non-NULL previous_entitlement_revision_id';
    END IF;
    IF NEW.operation NOT IN ('UPDATE', 'VOID') THEN
      RAISE EXCEPTION 'Subsequent entitlement revision must have operation UPDATE or VOID';
    END IF;

    SELECT * INTO v_prev_ent_rev
    FROM income_entitlement_revisions
    WHERE id = NEW.previous_entitlement_revision_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous_entitlement_revision % not found', NEW.previous_entitlement_revision_id;
    END IF;

    IF v_prev_ent_rev.entitlement_id != NEW.entitlement_id THEN
      RAISE EXCEPTION 'previous_entitlement_revision entitlement_id does not match';
    END IF;

    IF v_prev_ent_rev.revision_no != (NEW.revision_no - 1) THEN
      RAISE EXCEPTION 'previous_entitlement_revision revision_no % does not equal expected %',
        v_prev_ent_rev.revision_no, (NEW.revision_no - 1);
    END IF;

    IF v_prev_ent_rev.canonical_revision_id != v_rev.previous_revision_id THEN
      RAISE EXCEPTION 'previous_entitlement_revision canonical_revision_id does not match canonical previous_revision_id';
    END IF;

    IF v_prev_ent_rev.operation = 'VOID' THEN
      RAISE EXCEPTION 'Cannot append new revision to an already VOIDED entitlement';
    END IF;

    IF NEW.operation = 'VOID' THEN
      IF NEW.amount != v_prev_ent_rev.amount THEN
        RAISE EXCEPTION 'VOID entitlement revision must retain previous amount';
      END IF;
      IF (NEW.expected_receipt_on IS DISTINCT FROM v_prev_ent_rev.expected_receipt_on) THEN
        RAISE EXCEPTION 'VOID entitlement revision must retain previous expected_receipt_on';
      END IF;
      IF (NEW.note IS DISTINCT FROM v_prev_ent_rev.note) THEN
        RAISE EXCEPTION 'VOID entitlement revision must retain previous note';
      END IF;
    END IF;
  END IF;

  -- 6. Canonical payload exact validation
  IF NOT (v_rev.payload ? 'incomeSourceId') OR
     NOT (v_rev.payload ? 'periodMonth') OR
     NOT (v_rev.payload ? 'amount') OR
     NOT (v_rev.payload ? 'expectedReceiptOn') OR
     NOT (v_rev.payload ? 'note') THEN
    RAISE EXCEPTION 'canonical payload for INCOME_ENTITLEMENT missing required keys';
  END IF;

  IF (v_rev.payload->>'incomeSourceId') != (v_entitlement.source_id::text) THEN
    RAISE EXCEPTION 'canonical payload incomeSourceId % does not match entitlement source_id %',
      (v_rev.payload->>'incomeSourceId'), v_entitlement.source_id;
  END IF;

  IF (v_rev.payload->>'periodMonth') != (v_entitlement.period_month::text) THEN
    RAISE EXCEPTION 'canonical payload periodMonth % does not match entitlement period_month %',
      (v_rev.payload->>'periodMonth'), v_entitlement.period_month;
  END IF;

  IF (v_rev.payload->>'amount') != (NEW.amount::text) THEN
    RAISE EXCEPTION 'canonical payload amount % does not match revision amount %',
      (v_rev.payload->>'amount'), NEW.amount::text;
  END IF;

  IF NEW.expected_receipt_on IS NULL THEN
    IF jsonb_typeof(v_rev.payload->'expectedReceiptOn') != 'null' THEN
      RAISE EXCEPTION 'canonical payload expectedReceiptOn must be JSON null when expected_receipt_on is NULL';
    END IF;
  ELSE
    IF (v_rev.payload->>'expectedReceiptOn') != (NEW.expected_receipt_on::text) THEN
      RAISE EXCEPTION 'canonical payload expectedReceiptOn % does not match revision %',
        (v_rev.payload->>'expectedReceiptOn'), NEW.expected_receipt_on::text;
    END IF;
  END IF;

  IF NEW.note IS NULL THEN
    IF jsonb_typeof(v_rev.payload->'note') != 'null' THEN
      RAISE EXCEPTION 'canonical payload note must be JSON null when note is NULL';
    END IF;
  ELSE
    IF jsonb_typeof(v_rev.payload->'note') != 'string' OR
       (v_rev.payload->>'note') != NEW.note THEN
      RAISE EXCEPTION 'canonical payload note does not match revision note';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_income_entitlement_revisions_insert
BEFORE INSERT ON income_entitlement_revisions
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_income_entitlement_revisions_insert();--> statement-breakpoint

-- ============================================================================
-- HARDENED TRIGGER: income_settlement_batch_revisions insert
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_income_settlement_batch_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_batch RECORD;
  v_receipt RECORD;
  v_latest_receipt_rev RECORD;
  v_canon_tx RECORD;
  v_rev RECORD;
  v_prev_batch_rev RECORD;
  v_alloc_elem jsonb;
  v_alloc_count integer;
  v_idx integer;
  v_prev_ent_id text := '';
  v_elem_ent_id text;
  v_elem_amount_str text;
  v_elem_amount numeric;
  v_total_alloc numeric := 0;
  v_ent RECORD;
  v_latest_ent_rev RECORD;
  v_other_alloc_total numeric;
BEGIN
  -- 1. Validate batch exists and belongs to user
  SELECT * INTO v_batch
  FROM income_settlement_batches
  WHERE id = NEW.settlement_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_settlement_batches row % not found', NEW.settlement_batch_id;
  END IF;

  IF v_batch.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_settlement_batches user_id % does not match revision user_id %',
      v_batch.user_id, NEW.user_id;
  END IF;

  -- 2. Validate receipt exists, belongs to user, and latest revision is not VOID
  SELECT * INTO v_receipt
  FROM income_receipts
  WHERE id = v_batch.income_receipt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_receipts row % not found', v_batch.income_receipt_id;
  END IF;

  IF v_receipt.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_receipts user_id % does not match settlement user_id %',
      v_receipt.user_id, NEW.user_id;
  END IF;

  SELECT * INTO v_latest_receipt_rev
  FROM income_receipt_revisions
  WHERE income_receipt_id = v_receipt.id
  ORDER BY revision_no DESC
  LIMIT 1;

  IF NOT FOUND OR v_latest_receipt_rev.operation = 'VOID' THEN
    RAISE EXCEPTION 'Cannot settle against non-existent or VOIDED income receipt %', v_receipt.id;
  END IF;

  -- 3. Validate canonical transaction
  SELECT * INTO v_canon_tx
  FROM canonical_transactions
  WHERE id = v_batch.canonical_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical_transactions row % not found', v_batch.canonical_transaction_id;
  END IF;

  IF v_canon_tx.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_transaction user_id % does not match revision user_id %',
      v_canon_tx.user_id, NEW.user_id;
  END IF;

  IF v_canon_tx.kind != 'INCOME_SETTLEMENT' THEN
    RAISE EXCEPTION 'canonical_transaction kind must be INCOME_SETTLEMENT, found %',
      v_canon_tx.kind;
  END IF;

  -- 4. Validate canonical revision
  SELECT * INTO v_rev
  FROM transaction_revisions
  WHERE id = NEW.canonical_revision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_revisions row % not found', NEW.canonical_revision_id;
  END IF;

  IF v_rev.transaction_id != v_batch.canonical_transaction_id THEN
    RAISE EXCEPTION 'canonical_revision transaction_id does not match batch canonical_transaction_id';
  END IF;

  IF v_rev.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_revision user_id does not match revision user_id';
  END IF;

  IF v_rev.revision_no != NEW.revision_no THEN
    RAISE EXCEPTION 'canonical_revision revision_no does not match revision_no';
  END IF;

  IF v_rev.operation != NEW.operation THEN
    RAISE EXCEPTION 'canonical_revision operation does not match revision operation';
  END IF;

  -- 5. Revision chain validation
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_settlement_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First settlement batch revision must have NULL previous_settlement_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First settlement batch revision must have operation CREATE';
    END IF;
    IF v_rev.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First canonical revision must have NULL previous_revision_id';
    END IF;
  ELSE
    IF NEW.previous_settlement_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent settlement batch revision must have non-NULL previous_settlement_revision_id';
    END IF;
    IF NEW.operation != 'UPDATE' THEN
      RAISE EXCEPTION 'Subsequent settlement batch revision must have operation UPDATE';
    END IF;

    SELECT * INTO v_prev_batch_rev
    FROM income_settlement_batch_revisions
    WHERE id = NEW.previous_settlement_revision_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous_settlement_revision % not found', NEW.previous_settlement_revision_id;
    END IF;

    IF v_prev_batch_rev.settlement_batch_id != NEW.settlement_batch_id THEN
      RAISE EXCEPTION 'previous_settlement_revision settlement_batch_id does not match';
    END IF;

    IF v_prev_batch_rev.revision_no != (NEW.revision_no - 1) THEN
      RAISE EXCEPTION 'previous_settlement_revision revision_no does not equal expected';
    END IF;

    IF v_prev_batch_rev.canonical_revision_id != v_rev.previous_revision_id THEN
      RAISE EXCEPTION 'previous_settlement_revision canonical_revision_id does not match canonical previous_revision_id';
    END IF;
  END IF;

  -- 6. Canonical payload exact validation
  IF NOT (v_rev.payload ? 'incomeReceiptId') OR
     NOT (v_rev.payload ? 'allocations') OR
     NOT (v_rev.payload ? 'note') THEN
    RAISE EXCEPTION 'canonical payload for INCOME_SETTLEMENT missing required keys';
  END IF;

  IF (v_rev.payload->>'incomeReceiptId') != (v_batch.income_receipt_id::text) THEN
    RAISE EXCEPTION 'canonical payload incomeReceiptId does not match batch income_receipt_id';
  END IF;

  IF (v_rev.payload->'allocations') != NEW.allocations THEN
    RAISE EXCEPTION 'canonical payload allocations does not match revision allocations';
  END IF;

  IF NEW.note IS NULL THEN
    IF jsonb_typeof(v_rev.payload->'note') != 'null' THEN
      RAISE EXCEPTION 'canonical payload note must be JSON null when note is NULL';
    END IF;
  ELSE
    IF jsonb_typeof(v_rev.payload->'note') != 'string' OR
       (v_rev.payload->>'note') != NEW.note THEN
      RAISE EXCEPTION 'canonical payload note does not match revision note';
    END IF;
  END IF;

  -- 7. Validate allocations structure and sorting
  IF jsonb_typeof(NEW.allocations) != 'array' THEN
    RAISE EXCEPTION 'allocations must be a JSON array';
  END IF;

  v_alloc_count := jsonb_array_length(NEW.allocations);

  IF NEW.revision_no = 1 AND v_alloc_count = 0 THEN
    RAISE EXCEPTION 'CREATE settlement batch revision requires at least 1 allocation';
  END IF;

  FOR v_idx IN 0..(v_alloc_count - 1) LOOP
    v_alloc_elem := NEW.allocations->v_idx;

    IF jsonb_typeof(v_alloc_elem) != 'object' THEN
      RAISE EXCEPTION 'Allocation item at index % is not a JSON object', v_idx;
    END IF;

    IF NOT (v_alloc_elem ? 'entitlementId') OR NOT (v_alloc_elem ? 'amount') THEN
      RAISE EXCEPTION 'Allocation item at index % missing entitlementId or amount', v_idx;
    END IF;

    v_elem_ent_id := v_alloc_elem->>'entitlementId';
    v_elem_amount_str := v_alloc_elem->>'amount';

    IF v_elem_ent_id IS NULL OR v_elem_ent_id = '' THEN
      RAISE EXCEPTION 'Allocation item at index % has invalid entitlementId', v_idx;
    END IF;

    IF v_elem_amount_str IS NULL OR NOT (v_elem_amount_str ~ '^(0|[1-9][0-9]*)\.[0-9]{2}$') THEN
      RAISE EXCEPTION 'Allocation item at index % has unnormalized amount string %', v_idx, v_elem_amount_str;
    END IF;

    v_elem_amount := v_elem_amount_str::numeric;
    IF v_elem_amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amount at index % must be strictly positive', v_idx;
    END IF;

    -- Strict sorting and duplicate check (entitlementId ASC)
    IF v_elem_ent_id <= v_prev_ent_id THEN
      RAISE EXCEPTION 'Allocations must be strictly sorted by entitlementId ASC without duplicates (found % after %)',
        v_elem_ent_id, v_prev_ent_id;
    END IF;
    v_prev_ent_id := v_elem_ent_id;

    -- Validate entitlement exists, belongs to same user and source
    SELECT * INTO v_ent
    FROM income_entitlements
    WHERE id = v_elem_ent_id::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Allocated entitlement % not found', v_elem_ent_id;
    END IF;

    IF v_ent.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'Allocated entitlement % belongs to different user', v_elem_ent_id;
    END IF;

    IF v_ent.source_id != v_receipt.source_id THEN
      RAISE EXCEPTION 'Allocated entitlement % source % does not match receipt source %',
        v_elem_ent_id, v_ent.source_id, v_receipt.source_id;
    END IF;

    -- Fetch latest entitlement revision
    SELECT * INTO v_latest_ent_rev
    FROM income_entitlement_revisions
    WHERE entitlement_id = v_ent.id
    ORDER BY revision_no DESC
    LIMIT 1;

    IF NOT FOUND OR v_latest_ent_rev.operation = 'VOID' THEN
      RAISE EXCEPTION 'Cannot allocate to non-existent or VOIDED entitlement %', v_elem_ent_id;
    END IF;

    -- Calculate current allocations to this entitlement across other active batches
    SELECT COALESCE(SUM((alloc_elem->>'amount')::numeric), 0)
    INTO v_other_alloc_total
    FROM (
      SELECT DISTINCT ON (settlement_batch_id) allocations
      FROM income_settlement_batch_revisions
      WHERE user_id = NEW.user_id
        AND settlement_batch_id != NEW.settlement_batch_id
      ORDER BY settlement_batch_id, revision_no DESC
    ) latest_other_batches,
    LATERAL jsonb_array_elements(latest_other_batches.allocations) alloc_elem
    WHERE (alloc_elem->>'entitlementId') = v_elem_ent_id;

    IF (v_other_alloc_total + v_elem_amount) > v_latest_ent_rev.amount THEN
      RAISE EXCEPTION 'Total allocation % exceeds active entitlement amount % for entitlement %',
        (v_other_alloc_total + v_elem_amount), v_latest_ent_rev.amount, v_elem_ent_id;
    END IF;

    v_total_alloc := v_total_alloc + v_elem_amount;
  END LOOP;

  -- 8. Validate receipt total cap
  IF v_total_alloc > v_latest_receipt_rev.amount THEN
    RAISE EXCEPTION 'Total allocations % exceed active income receipt amount %',
      v_total_alloc, v_latest_receipt_rev.amount;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_income_settlement_batch_revisions_insert
BEFORE INSERT ON income_settlement_batch_revisions
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_income_settlement_batch_revisions_insert();
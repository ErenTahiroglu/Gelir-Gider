CREATE TABLE "credit_card_purchase_split_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"split_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"person_obligation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_card_purchase_split_revision_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"split_revision_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"share_amount" numeric(18, 2) NOT NULL,
	"weight" integer,
	"due_date" date,
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_card_purchase_split_revision_items_share_check" CHECK ("credit_card_purchase_split_revision_items"."share_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_card_purchase_split_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"split_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(32) NOT NULL,
	"method" varchar(32) NOT NULL,
	"purchase_event_revision_id" uuid NOT NULL,
	"gross_amount" numeric(18, 2) NOT NULL,
	"user_share_amount" numeric(18, 2) NOT NULL,
	"external_share_amount" numeric(18, 2) NOT NULL,
	"user_weight" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128),
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_card_purchase_split_revisions_op_check" CHECK ("credit_card_purchase_split_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "credit_card_purchase_split_revisions_method_check" CHECK ("credit_card_purchase_split_revisions"."method" IN ('EQUAL', 'MANUAL', 'RATIO')),
	CONSTRAINT "credit_card_purchase_split_revisions_gross_amount_check" CHECK ("credit_card_purchase_split_revisions"."gross_amount" > 0),
	CONSTRAINT "credit_card_purchase_split_revisions_user_share_check" CHECK ("credit_card_purchase_split_revisions"."user_share_amount" >= 0),
	CONSTRAINT "credit_card_purchase_split_revisions_ext_share_check" CHECK ("credit_card_purchase_split_revisions"."external_share_amount" >= 0),
	CONSTRAINT "credit_card_purchase_split_revisions_sum_check" CHECK ("credit_card_purchase_split_revisions"."gross_amount" = "credit_card_purchase_split_revisions"."user_share_amount" + "credit_card_purchase_split_revisions"."external_share_amount"),
	CONSTRAINT "credit_card_purchase_split_revisions_fingerprint_check" CHECK ("credit_card_purchase_split_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credit_card_purchase_split_revisions_idempotency_check" CHECK ("credit_card_purchase_split_revisions"."idempotency_key" IS NULL OR ("credit_card_purchase_split_revisions"."idempotency_key" = btrim("credit_card_purchase_split_revisions"."idempotency_key") AND length("credit_card_purchase_split_revisions"."idempotency_key") BETWEEN 1 AND 128))
);
--> statement-breakpoint
CREATE TABLE "credit_card_purchase_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purchase_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_participants" ADD CONSTRAINT "credit_card_purchase_split_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_participants" ADD CONSTRAINT "credit_card_purchase_split_participants_split_id_credit_card_purchase_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."credit_card_purchase_splits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_participants" ADD CONSTRAINT "credit_card_purchase_split_participants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_participants" ADD CONSTRAINT "credit_card_purchase_split_participants_person_obligation_id_person_obligations_id_fk" FOREIGN KEY ("person_obligation_id") REFERENCES "public"."person_obligations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_revision_items" ADD CONSTRAINT "credit_card_purchase_split_revision_items_split_revision_id_credit_card_purchase_split_revisions_id_fk" FOREIGN KEY ("split_revision_id") REFERENCES "public"."credit_card_purchase_split_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_revision_items" ADD CONSTRAINT "credit_card_purchase_split_revision_items_participant_id_credit_card_purchase_split_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."credit_card_purchase_split_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_revision_items" ADD CONSTRAINT "credit_card_purchase_split_revision_items_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_revisions" ADD CONSTRAINT "credit_card_purchase_split_revisions_split_id_credit_card_purchase_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."credit_card_purchase_splits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_revisions" ADD CONSTRAINT "credit_card_purchase_split_revisions_previous_revision_id_credit_card_purchase_split_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."credit_card_purchase_split_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_split_revisions" ADD CONSTRAINT "credit_card_purchase_split_revisions_purchase_event_revision_id_credit_card_liability_event_revisions_id_fk" FOREIGN KEY ("purchase_event_revision_id") REFERENCES "public"."credit_card_liability_event_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_splits" ADD CONSTRAINT "credit_card_purchase_splits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_purchase_splits" ADD CONSTRAINT "credit_card_purchase_splits_purchase_event_id_credit_card_liability_events_id_fk" FOREIGN KEY ("purchase_event_id") REFERENCES "public"."credit_card_liability_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_purchase_split_participants_obligation_uq" ON "credit_card_purchase_split_participants" USING btree ("person_obligation_id");--> statement-breakpoint
CREATE INDEX "credit_card_purchase_split_participants_split_idx" ON "credit_card_purchase_split_participants" USING btree ("split_id");--> statement-breakpoint
CREATE INDEX "credit_card_purchase_split_participants_person_idx" ON "credit_card_purchase_split_participants" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "credit_card_purchase_split_participants_user_idx" ON "credit_card_purchase_split_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_purchase_split_revision_items_rev_person_uq" ON "credit_card_purchase_split_revision_items" USING btree ("split_revision_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_purchase_split_revision_items_rev_participant_uq" ON "credit_card_purchase_split_revision_items" USING btree ("split_revision_id","participant_id");--> statement-breakpoint
CREATE INDEX "credit_card_purchase_split_revision_items_rev_idx" ON "credit_card_purchase_split_revision_items" USING btree ("split_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_purchase_split_revisions_split_revision_no_uq" ON "credit_card_purchase_split_revisions" USING btree ("split_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_purchase_split_revisions_split_prev_revision_uq" ON "credit_card_purchase_split_revisions" USING btree ("split_id","previous_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_purchase_split_revisions_split_idempotency_key_uq" ON "credit_card_purchase_split_revisions" USING btree ("split_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_card_purchase_split_revisions_purchase_rev_idx" ON "credit_card_purchase_split_revisions" USING btree ("purchase_event_revision_id");--> statement-breakpoint
CREATE INDEX "credit_card_purchase_split_revisions_split_idx" ON "credit_card_purchase_split_revisions" USING btree ("split_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_card_purchase_splits_purchase_event_id_uq" ON "credit_card_purchase_splits" USING btree ("purchase_event_id");--> statement-breakpoint
CREATE INDEX "credit_card_purchase_splits_user_id_idx" ON "credit_card_purchase_splits" USING btree ("user_id");--> statement-breakpoint

-- ============================================================================
-- 1. IMMUTABILITY TRIGGERS: PREVENT DIRECT UPDATE/DELETE ON SPLIT TABLES
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_credit_card_splits()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'Table % is immutable (INSERT-only)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_credit_card_purchase_splits ON "credit_card_purchase_splits";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_credit_card_purchase_splits
BEFORE UPDATE OR DELETE ON "credit_card_purchase_splits"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_credit_card_splits();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_credit_card_purchase_split_revisions ON "credit_card_purchase_split_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_credit_card_purchase_split_revisions
BEFORE UPDATE OR DELETE ON "credit_card_purchase_split_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_credit_card_splits();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_credit_card_purchase_split_participants ON "credit_card_purchase_split_participants";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_credit_card_purchase_split_participants
BEFORE UPDATE OR DELETE ON "credit_card_purchase_split_participants"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_credit_card_splits();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_credit_card_purchase_split_revision_items ON "credit_card_purchase_split_revision_items";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_credit_card_purchase_split_revision_items
BEFORE UPDATE OR DELETE ON "credit_card_purchase_split_revision_items"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_credit_card_splits();--> statement-breakpoint

-- ============================================================================
-- 2. SPLIT REVISION INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_split_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_split RECORD;
	v_purchase_event RECORD;
	v_purchase_rev RECORD;
	v_prev_rev RECORD;
	v_latest_split_rev RECORD;
BEGIN
	SELECT * INTO v_split FROM credit_card_purchase_splits WHERE id = NEW.split_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card purchase split % not found', NEW.split_id;
	END IF;

	SELECT * INTO v_purchase_event FROM credit_card_liability_events WHERE id = v_split.purchase_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Purchase event % not found for split %', v_split.purchase_event_id, NEW.split_id;
	END IF;
	IF v_purchase_event.event_type != 'PURCHASE' THEN
		RAISE EXCEPTION 'Cannot create split on liability event % with event_type %', v_purchase_event.id, v_purchase_event.event_type;
	END IF;
	IF v_purchase_event.user_id != v_split.user_id THEN
		RAISE EXCEPTION 'Purchase event user_id % does not match split user_id %', v_purchase_event.user_id, v_split.user_id;
	END IF;

	SELECT * INTO v_purchase_rev FROM credit_card_liability_event_revisions WHERE id = NEW.purchase_event_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Purchase event revision % not found', NEW.purchase_event_revision_id;
	END IF;
	IF v_purchase_rev.event_id != v_split.purchase_event_id THEN
		RAISE EXCEPTION 'Purchase event revision % does not belong to purchase event %', NEW.purchase_event_revision_id, v_split.purchase_event_id;
	END IF;
	IF NEW.gross_amount != v_purchase_rev.amount THEN
		RAISE EXCEPTION 'Split revision gross_amount % does not match purchase revision amount %', NEW.gross_amount, v_purchase_rev.amount;
	END IF;

	SELECT * INTO v_latest_split_rev
	FROM credit_card_purchase_split_revisions
	WHERE split_id = NEW.split_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.operation = 'CREATE' THEN
		IF NEW.revision_no != 1 THEN
			RAISE EXCEPTION 'Split CREATE revision must have revision_no = 1, found %', NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'Split CREATE revision must have previous_revision_id NULL';
		END IF;
		IF v_latest_split_rev IS NOT NULL THEN
			RAISE EXCEPTION 'Split % already has existing revisions (revision branching forbidden)', NEW.split_id;
		END IF;
		IF v_purchase_rev.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create split on voided purchase revision %', v_purchase_rev.id;
		END IF;
	ELSIF NEW.operation IN ('UPDATE', 'VOID') THEN
		IF v_latest_split_rev IS NULL THEN
			RAISE EXCEPTION 'Split % has no existing revisions to %', NEW.split_id, NEW.operation;
		END IF;
		IF v_latest_split_rev.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot mutate split % with terminal VOID latest revision', NEW.split_id;
		END IF;
		IF NEW.revision_no != v_latest_split_rev.revision_no + 1 THEN
			RAISE EXCEPTION 'Split % expected revision_no % but found % (split revision branching forbidden)',
				NEW.split_id, v_latest_split_rev.revision_no + 1, NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id IS DISTINCT FROM v_latest_split_rev.id THEN
			RAISE EXCEPTION 'Split % previous_revision_id % does not match latest revision id %',
				NEW.split_id, NEW.previous_revision_id, v_latest_split_rev.id;
		END IF;
	ELSE
		RAISE EXCEPTION 'Unknown split operation %', NEW.operation;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_split_revision_insert ON "credit_card_purchase_split_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_split_revision_insert
BEFORE INSERT ON "credit_card_purchase_split_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_split_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 3. SPLIT REVISION ITEMS INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_split_revision_items_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_split_rev RECORD;
	v_participant RECORD;
BEGIN
	SELECT * INTO v_split_rev FROM credit_card_purchase_split_revisions WHERE id = NEW.split_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Split revision % not found for revision item', NEW.split_revision_id;
	END IF;

	SELECT * INTO v_participant FROM credit_card_purchase_split_participants WHERE id = NEW.participant_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Split participant % not found for revision item', NEW.participant_id;
	END IF;

	IF v_participant.split_id != v_split_rev.split_id THEN
		RAISE EXCEPTION 'Participant % split_id % does not match split revision split_id %',
			NEW.participant_id, v_participant.split_id, v_split_rev.split_id;
	END IF;

	IF v_participant.person_id != NEW.person_id THEN
		RAISE EXCEPTION 'Participant % person_id % does not match revision item person_id %',
			NEW.participant_id, v_participant.person_id, NEW.person_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_split_revision_items_insert ON "credit_card_purchase_split_revision_items";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_split_revision_items_insert
BEFORE INSERT ON "credit_card_purchase_split_revision_items"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_split_revision_items_insert();--> statement-breakpoint

-- ============================================================================
-- 4. UPDATE OBLIGATION REVISION GUARD TO SUPPORT CREDIT_CARD_PURCHASE_SPLIT
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation RECORD;
	v_can_tx RECORD;
	v_can_rev RECORD;
	v_latest RECORD;
	v_funding_account RECORD;
	v_user_currency TEXT;
	v_invalid_key TEXT;
	v_active_settled NUMERIC;
	v_split RECORD;
	v_participant RECORD;
	v_expense_account RECORD;
	v_purchase_rev RECORD;
	v_expected_system_role TEXT;
	v_system_account RECORD;
BEGIN
	-- 1. Obligation anchor resolution
	SELECT * INTO v_obligation FROM person_obligations WHERE id = NEW.obligation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person obligation % not found', NEW.obligation_id;
	END IF;
	IF v_obligation.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Obligation user_id % does not match revision user_id %', v_obligation.user_id, NEW.user_id;
	END IF;

	-- 2. Canonical Transaction + Revision resolution
	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_obligation.canonical_transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found for obligation %', v_obligation.canonical_transaction_id, NEW.obligation_id;
	END IF;
	IF v_can_tx.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical transaction % user_id does not match obligation user_id', v_can_tx.id;
	END IF;

	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found for obligation %', NEW.canonical_revision_id, NEW.obligation_id;
	END IF;
	IF v_can_rev.transaction_id != v_can_tx.id THEN
		RAISE EXCEPTION 'Canonical revision % does not belong to obligation canonical transaction %', v_can_rev.id, v_can_tx.id;
	END IF;
	IF v_can_rev.revision_no != NEW.revision_no THEN
		RAISE EXCEPTION 'Canonical revision_no % does not match obligation revision_no %', v_can_rev.revision_no, NEW.revision_no;
	END IF;
	IF v_can_rev.operation != NEW.operation THEN
		RAISE EXCEPTION 'Canonical operation % does not match obligation operation %', v_can_rev.operation, NEW.operation;
	END IF;

	-- 3. Revision chain continuity
	SELECT * INTO v_latest
	FROM person_obligation_revisions
	WHERE obligation_id = NEW.obligation_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.operation = 'CREATE' THEN
		IF NEW.revision_no != 1 THEN
			RAISE EXCEPTION 'Obligation CREATE revision must have revision_no = 1, found %', NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'Obligation CREATE revision must have previous_revision_id NULL';
		END IF;
		IF v_latest IS NOT NULL THEN
			RAISE EXCEPTION 'Obligation % already has revisions (branching forbidden)', NEW.obligation_id;
		END IF;
	ELSIF NEW.operation IN ('UPDATE', 'VOID') THEN
		IF v_latest IS NULL THEN
			RAISE EXCEPTION 'Obligation % has no existing revisions to %', NEW.obligation_id, NEW.operation;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot mutate obligation % with terminal VOID latest revision', NEW.obligation_id;
		END IF;
		IF NEW.revision_no != v_latest.revision_no + 1 THEN
			RAISE EXCEPTION 'Obligation % expected revision_no % but found %',
				NEW.obligation_id, v_latest.revision_no + 1, NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id IS DISTINCT FROM v_latest.id THEN
			RAISE EXCEPTION 'Obligation % previous_revision_id % does not match latest revision id %',
				NEW.obligation_id, NEW.previous_revision_id, v_latest.id;
		END IF;
	END IF;

	-- 4. Kind-specific validation
	IF v_can_tx.kind = 'PERSON_RECEIVABLE_ADVANCE' THEN
		IF v_obligation.direction != 'RECEIVABLE' THEN
			RAISE EXCEPTION 'PERSON_RECEIVABLE_ADVANCE must have direction RECEIVABLE';
		END IF;
		IF NEW.funding_asset_account_id IS NULL THEN
			RAISE EXCEPTION 'PERSON_RECEIVABLE_ADVANCE requires funding_asset_account_id';
		END IF;
		IF NEW.budget_category IS NOT NULL THEN
			RAISE EXCEPTION 'PERSON_RECEIVABLE_ADVANCE must have budget_category NULL';
		END IF;

		SELECT * INTO v_funding_account FROM ledger_accounts WHERE id = NEW.funding_asset_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Funding asset account % not found', NEW.funding_asset_account_id;
		END IF;
		IF v_funding_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Funding asset account % belongs to a different user', NEW.funding_asset_account_id;
		END IF;
		IF v_funding_account.account_type != 'ASSET' OR v_funding_account.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'Funding asset account % must be ASSET/DEBIT', NEW.funding_asset_account_id;
		END IF;

		SELECT currency INTO v_user_currency FROM users WHERE id = NEW.user_id;
		IF v_funding_account.currency != v_user_currency THEN
			RAISE EXCEPTION 'Funding asset account % currency does not match user currency', NEW.funding_asset_account_id;
		END IF;

		-- Canonical payload key whitelist
		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'personId', 'direction', 'amount', 'fundingAssetAccountId', 'dueDate', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in PERSON_RECEIVABLE_ADVANCE canonical payload', v_invalid_key;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'fundingAssetAccountId') != 'string' OR
		   v_can_rev.payload->>'fundingAssetAccountId' != NEW.funding_asset_account_id::text THEN
			RAISE EXCEPTION 'Canonical payload fundingAssetAccountId % does not match revision %',
				v_can_rev.payload->>'fundingAssetAccountId', NEW.funding_asset_account_id;
		END IF;

	ELSIF v_can_tx.kind = 'CREDIT_CARD_PURCHASE_SPLIT' THEN
		IF v_obligation.direction != 'RECEIVABLE' THEN
			RAISE EXCEPTION 'CREDIT_CARD_PURCHASE_SPLIT must have direction RECEIVABLE';
		END IF;
		IF NEW.funding_asset_account_id IS NOT NULL THEN
			RAISE EXCEPTION 'CREDIT_CARD_PURCHASE_SPLIT must have funding_asset_account_id NULL';
		END IF;
		IF NEW.budget_category IS NOT NULL THEN
			RAISE EXCEPTION 'CREDIT_CARD_PURCHASE_SPLIT must have budget_category NULL';
		END IF;

		-- Canonical payload key whitelist
		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'splitId', 'splitRevisionId', 'splitParticipantId', 'purchaseEventId', 'personId', 'direction', 'amount', 'expenseAccountId', 'dueDate', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in CREDIT_CARD_PURCHASE_SPLIT canonical payload', v_invalid_key;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'expenseAccountId') != 'string' THEN
			RAISE EXCEPTION 'Canonical payload expenseAccountId missing or not a string';
		END IF;

		SELECT * INTO v_expense_account FROM ledger_accounts WHERE id = (v_can_rev.payload->>'expenseAccountId')::uuid;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Expense account % not found', v_can_rev.payload->>'expenseAccountId';
		END IF;
		IF v_expense_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Expense account % belongs to a different user', v_expense_account.id;
		END IF;
		IF v_expense_account.account_type != 'EXPENSE' OR v_expense_account.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'Expense account % must be EXPENSE/DEBIT', v_expense_account.id;
		END IF;

	ELSIF v_can_tx.kind = 'PERSON_PAYABLE_EXPENSE' THEN
		IF v_obligation.direction != 'PAYABLE' THEN
			RAISE EXCEPTION 'PERSON_PAYABLE_EXPENSE must have direction PAYABLE';
		END IF;
		IF NEW.budget_category IS NULL THEN
			RAISE EXCEPTION 'PERSON_PAYABLE_EXPENSE requires budget_category';
		END IF;
		IF NEW.funding_asset_account_id IS NOT NULL THEN
			RAISE EXCEPTION 'PERSON_PAYABLE_EXPENSE must have funding_asset_account_id NULL';
		END IF;

		-- Canonical payload key whitelist
		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'personId', 'direction', 'amount', 'budgetCategory', 'dueDate', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in PERSON_PAYABLE_EXPENSE canonical payload', v_invalid_key;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'budgetCategory') != 'string' OR
		   v_can_rev.payload->>'budgetCategory' != NEW.budget_category THEN
			RAISE EXCEPTION 'Canonical payload budgetCategory % does not match revision %',
				v_can_rev.payload->>'budgetCategory', NEW.budget_category;
		END IF;
	ELSE
		RAISE EXCEPTION 'Unsupported canonical kind % for person obligation', v_can_tx.kind;
	END IF;

	-- 5. Standard canonical payload bindings
	IF jsonb_typeof(v_can_rev.payload->'obligationId') != 'string' OR
	   v_can_rev.payload->>'obligationId' != NEW.obligation_id::text THEN
		RAISE EXCEPTION 'Canonical payload obligationId % does not match obligation %',
			v_can_rev.payload->>'obligationId', NEW.obligation_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'personId') != 'string' OR
	   v_can_rev.payload->>'personId' != v_obligation.person_id::text THEN
		RAISE EXCEPTION 'Canonical payload personId % does not match obligation person %',
			v_can_rev.payload->>'personId', v_obligation.person_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'direction') != 'string' OR
	   v_can_rev.payload->>'direction' != v_obligation.direction THEN
		RAISE EXCEPTION 'Canonical payload direction % does not match obligation direction %',
			v_can_rev.payload->>'direction', v_obligation.direction;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'amount') != 'string' OR
	   v_can_rev.payload->>'amount' != NEW.principal_amount::text THEN
		RAISE EXCEPTION 'Canonical payload amount % does not match revision principal_amount %',
			v_can_rev.payload->>'amount', NEW.principal_amount;
	END IF;

	IF NEW.due_date IS NULL THEN
		IF v_can_rev.payload->'dueDate' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'dueDate') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload dueDate must be null when projection due_date is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'dueDate') != 'string' OR
		   v_can_rev.payload->>'dueDate' != NEW.due_date::text THEN
			RAISE EXCEPTION 'Canonical payload dueDate % does not match revision due_date %',
				v_can_rev.payload->>'dueDate', NEW.due_date;
		END IF;
	END IF;

	IF NEW.description IS NULL THEN
		IF v_can_rev.payload->'description' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'description') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload description must be null when projection description is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'description') != 'string' OR
		   v_can_rev.payload->>'description' != NEW.description THEN
			RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
				v_can_rev.payload->>'description', NEW.description;
		END IF;
	END IF;

	-- 6. Active settlement limit
	SELECT COALESCE(SUM(latest.applied_amount), 0) INTO v_active_settled
	FROM (
		SELECT DISTINCT ON (psr.settlement_id) psr.applied_amount, psr.operation
		FROM person_settlement_revisions psr
		JOIN person_settlements ps ON ps.id = psr.settlement_id
		WHERE ps.obligation_id = NEW.obligation_id
		ORDER BY psr.settlement_id, psr.revision_no DESC
	) latest
	WHERE latest.operation != 'VOID';

	IF NEW.operation = 'VOID' THEN
		IF v_active_settled != 0 THEN
			RAISE EXCEPTION 'Cannot VOID obligation % with active settled amount %', NEW.obligation_id, v_active_settled;
		END IF;
		IF NEW.principal_amount != v_latest.principal_amount THEN
			RAISE EXCEPTION 'VOID revision must copy forward previous principal_amount';
		END IF;
	ELSIF NEW.operation = 'UPDATE' THEN
		IF NEW.principal_amount < v_active_settled THEN
			RAISE EXCEPTION 'Cannot revise obligation % principal to % below active settled amount %',
				NEW.obligation_id, NEW.principal_amount, v_active_settled;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 5. UPDATE OBLIGATION LEDGER EFFECT GUARD FOR CREDIT_CARD_PURCHASE_SPLIT
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_ledger_effect()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation RECORD;
	v_can_tx RECORD;
	v_can_rev RECORD;
	v_link RECORD;
	v_binding RECORD;
	v_line_count INT;
	v_dr_account UUID;
	v_dr_amount NUMERIC;
	v_cr_account UUID;
	v_cr_amount NUMERIC;
	v_expected_role TEXT;
	v_expense_account_id UUID;
	v_prev_rev RECORD;
	v_prev_binding RECORD;
	v_prev_dr_account UUID;
	v_prev_dr_amount NUMERIC;
	v_prev_cr_account UUID;
	v_prev_cr_amount NUMERIC;
BEGIN
	SELECT * INTO v_obligation FROM person_obligations WHERE id = NEW.obligation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Obligation % not found for ledger effect check', NEW.obligation_id;
	END IF;

	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_obligation.canonical_transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found for obligation %', v_obligation.canonical_transaction_id, NEW.obligation_id;
	END IF;

	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found for obligation %', NEW.canonical_revision_id, NEW.obligation_id;
	END IF;

	SELECT * INTO v_link FROM person_ledger_links WHERE person_id = v_obligation.person_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person ledger link missing for person %', v_obligation.person_id;
	END IF;

	SELECT * INTO v_binding FROM transaction_ledger_bindings WHERE revision_id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'No transaction_ledger_bindings row for obligation revision %', NEW.id;
	END IF;

	IF NEW.operation IN ('CREATE', 'UPDATE') THEN
		IF v_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Obligation revision % has no applied journal entry', NEW.id;
		END IF;

		SELECT count(*) INTO v_line_count FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Obligation % applied journal entry must have exactly 2 lines, found %', NEW.obligation_id, v_line_count;
		END IF;

		SELECT account_id, debit INTO v_dr_account, v_dr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id AND debit > 0;
		SELECT account_id, credit INTO v_cr_account, v_cr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id AND credit > 0;

		IF v_can_tx.kind = 'CREDIT_CARD_PURCHASE_SPLIT' THEN
			IF v_dr_account != v_link.receivable_account_id THEN
				RAISE EXCEPTION 'Obligation % applied debit account % does not match person receivable account %',
					NEW.obligation_id, v_dr_account, v_link.receivable_account_id;
			END IF;
			IF v_cr_account != (v_can_rev.payload->>'expenseAccountId')::uuid THEN
				RAISE EXCEPTION 'Obligation % applied credit account % does not match split expense account %',
					NEW.obligation_id, v_cr_account, v_can_rev.payload->>'expenseAccountId';
			END IF;
		ELSIF v_can_tx.kind = 'PERSON_RECEIVABLE_ADVANCE' THEN
			IF v_dr_account != v_link.receivable_account_id THEN
				RAISE EXCEPTION 'Obligation % applied debit account % does not match person receivable account %',
					NEW.obligation_id, v_dr_account, v_link.receivable_account_id;
			END IF;
			IF v_cr_account != NEW.funding_asset_account_id THEN
				RAISE EXCEPTION 'Obligation % applied credit account % does not match funding_asset_account_id %',
					NEW.obligation_id, v_cr_account, NEW.funding_asset_account_id;
			END IF;
		ELSIF v_can_tx.kind = 'PERSON_PAYABLE_EXPENSE' THEN
			v_expected_role := CASE NEW.budget_category
				WHEN 'MANDATORY_EXPENSE' THEN 'MANDATORY_EXPENSE'
				WHEN 'DISCRETIONARY_SPEND' THEN 'DISCRETIONARY_EXPENSE'
				WHEN 'SHORT_TERM_PURCHASE' THEN 'SHORT_TERM_PURCHASE'
				WHEN 'UNCLASSIFIED' THEN 'UNCLASSIFIED_EXPENSE'
				ELSE NULL
			END;
			IF v_expected_role IS NULL THEN
				RAISE EXCEPTION 'Obligation % has unknown budget_category %', NEW.obligation_id, NEW.budget_category;
			END IF;
			SELECT ledger_account_id INTO v_expense_account_id
				FROM credit_card_system_accounts WHERE user_id = NEW.user_id AND role = v_expected_role;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'No system expense account provisioned for role % (user %)', v_expected_role, NEW.user_id;
			END IF;
			IF v_dr_account != v_expense_account_id THEN
				RAISE EXCEPTION 'Obligation % applied debit account % does not match expense account % for budget_category %',
					NEW.obligation_id, v_dr_account, v_expense_account_id, NEW.budget_category;
			END IF;
			IF v_cr_account != v_link.payable_account_id THEN
				RAISE EXCEPTION 'Obligation % applied credit account % does not match person payable account %',
					NEW.obligation_id, v_cr_account, v_link.payable_account_id;
			END IF;
		END IF;

		IF v_dr_amount != NEW.principal_amount OR v_cr_amount != NEW.principal_amount THEN
			RAISE EXCEPTION 'Obligation % applied journal amount does not match principal_amount %',
				NEW.obligation_id, NEW.principal_amount;
		END IF;

	ELSIF NEW.operation = 'VOID' THEN
		IF v_binding.reversal_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Obligation VOID revision % has no reversal journal entry', NEW.id;
		END IF;
		IF v_binding.applied_journal_entry_id IS NOT NULL THEN
			RAISE EXCEPTION 'Obligation VOID revision % must not have an applied journal entry', NEW.id;
		END IF;

		SELECT * INTO v_prev_rev FROM person_obligation_revisions WHERE id = NEW.previous_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'VOID revision % missing previous revision for reversal check', NEW.id;
		END IF;
		SELECT * INTO v_prev_binding FROM transaction_ledger_bindings WHERE revision_id = v_prev_rev.canonical_revision_id;
		IF NOT FOUND OR v_prev_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Previous revision % has no applied journal entry to reverse', v_prev_rev.id;
		END IF;

		SELECT count(*) INTO v_line_count FROM journal_lines WHERE journal_entry_id = v_binding.reversal_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Obligation VOID revision % reversal journal entry must have exactly 2 lines, found %', NEW.id, v_line_count;
		END IF;

		SELECT account_id, debit INTO v_dr_account, v_dr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.reversal_journal_entry_id AND debit > 0;
		SELECT account_id, credit INTO v_cr_account, v_cr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.reversal_journal_entry_id AND credit > 0;

		SELECT account_id, credit INTO v_prev_cr_account, v_prev_cr_amount
			FROM journal_lines WHERE journal_entry_id = v_prev_binding.applied_journal_entry_id AND credit > 0;
		SELECT account_id, debit INTO v_prev_dr_account, v_prev_dr_amount
			FROM journal_lines WHERE journal_entry_id = v_prev_binding.applied_journal_entry_id AND debit > 0;

		IF v_dr_account != v_prev_cr_account OR v_dr_amount != v_prev_cr_amount THEN
			RAISE EXCEPTION 'Obligation % VOID reversal debit line does not mirror original credit line', NEW.obligation_id;
		END IF;
		IF v_cr_account != v_prev_dr_account OR v_cr_amount != v_prev_dr_amount THEN
			RAISE EXCEPTION 'Obligation % VOID reversal credit line does not mirror original debit line', NEW.obligation_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 6. UPDATE CANONICAL COMMIT COMPLETENESS FOR CREDIT_CARD_PURCHASE_SPLIT
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_canonical_transactions_commit()
RETURNS TRIGGER AS $$
DECLARE
	v_can_rev RECORD;
	v_obligation RECORD;
	v_obligation_rev RECORD;
	v_settlement RECORD;
	v_settlement_rev RECORD;
	v_split_participant RECORD;
BEGIN
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE transaction_id = NEW.id AND revision_no = 1;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical % transaction % has no initial revision #1 at commit', NEW.kind, NEW.id;
	END IF;
	IF v_can_rev.operation != 'CREATE' THEN
		RAISE EXCEPTION 'Canonical % transaction % revision #1 must have operation CREATE, found %',
			NEW.kind, NEW.id, v_can_rev.operation;
	END IF;
	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical % transaction % user_id % does not match revision user_id %',
			NEW.kind, NEW.id, NEW.user_id, v_can_rev.user_id;
	END IF;

	IF NEW.kind IN ('PERSON_RECEIVABLE_ADVANCE', 'PERSON_PAYABLE_EXPENSE', 'CREDIT_CARD_PURCHASE_SPLIT') THEN
		SELECT * INTO v_obligation FROM person_obligations WHERE canonical_transaction_id = NEW.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical % transaction % has no linked person_obligations anchor at commit', NEW.kind, NEW.id;
		END IF;

		SELECT * INTO v_obligation_rev FROM person_obligation_revisions WHERE canonical_revision_id = v_can_rev.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical % transaction % revision % has no linked person_obligation_revisions row at commit',
				NEW.kind, NEW.id, v_can_rev.id;
		END IF;
		IF v_obligation_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Canonical % transaction % obligation revision % must have operation CREATE, found %',
				NEW.kind, NEW.id, v_obligation_rev.id, v_obligation_rev.operation;
		END IF;

		IF NEW.kind = 'CREDIT_CARD_PURCHASE_SPLIT' THEN
			SELECT * INTO v_split_participant FROM credit_card_purchase_split_participants WHERE person_obligation_id = v_obligation.id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Canonical CREDIT_CARD_PURCHASE_SPLIT transaction % has no linked credit_card_purchase_split_participants anchor at commit', NEW.id;
			END IF;
		END IF;
	ELSIF NEW.kind = 'PERSON_OBLIGATION_SETTLEMENT' THEN
		SELECT * INTO v_settlement FROM person_settlements WHERE canonical_transaction_id = NEW.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical PERSON_OBLIGATION_SETTLEMENT transaction % has no linked person_settlements anchor at commit', NEW.id;
		END IF;

		SELECT * INTO v_settlement_rev FROM person_settlement_revisions WHERE canonical_revision_id = v_can_rev.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical PERSON_OBLIGATION_SETTLEMENT transaction % revision % has no linked person_settlement_revisions row at commit',
				NEW.id, v_can_rev.id;
		END IF;
		IF v_settlement_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Canonical PERSON_OBLIGATION_SETTLEMENT transaction % settlement revision % must have operation CREATE, found %',
				NEW.id, v_settlement_rev.id, v_settlement_rev.operation;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 7. DEFERRED COMMIT-TIME TRIGGER: SPLIT INTEGRITY, SUMS, AND PURCHASE BINDING
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_split_commit_check()
RETURNS TRIGGER AS $$
DECLARE
	v_target_split_id UUID;
	v_split RECORD;
	v_latest_split_rev RECORD;
	v_latest_purchase_rev RECORD;
	v_item_count INT;
	v_item_sum NUMERIC;
	v_item RECORD;
	v_participant RECORD;
	v_obl RECORD;
	v_obl_rev RECORD;
	v_inactive_participant RECORD;
	v_inactive_obl_rev RECORD;
BEGIN
	IF TG_TABLE_NAME = 'credit_card_purchase_splits' THEN
		v_target_split_id := NEW.id;
	ELSE
		v_target_split_id := NEW.split_id;
	END IF;

	-- For each modified split:
	FOR v_split IN
		SELECT DISTINCT s.*
		FROM credit_card_purchase_splits s
		WHERE s.id = v_target_split_id
	LOOP
		-- 1. Check latest split revision
		SELECT * INTO v_latest_split_rev
		FROM credit_card_purchase_split_revisions
		WHERE split_id = v_split.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF v_latest_split_rev IS NOT NULL AND v_latest_split_rev.operation != 'VOID' THEN
			-- Check items for active split revision
			SELECT count(*), COALESCE(SUM(share_amount), 0)
			INTO v_item_count, v_item_sum
			FROM credit_card_purchase_split_revision_items
			WHERE split_revision_id = v_latest_split_rev.id;

			IF v_item_count < 1 OR v_item_count > 9 THEN
				RAISE EXCEPTION 'Active split revision % must have between 1 and 9 external participants, found %',
					v_latest_split_rev.id, v_item_count;
			END IF;

			IF v_item_sum != v_latest_split_rev.external_share_amount THEN
				RAISE EXCEPTION 'Active split revision % sum of item shares % does not match external_share_amount %',
					v_latest_split_rev.id, v_item_sum, v_latest_split_rev.external_share_amount;
			END IF;

			-- Check each item corresponds to active People obligation
			FOR v_item IN
				SELECT * FROM credit_card_purchase_split_revision_items
				WHERE split_revision_id = v_latest_split_rev.id
			LOOP
				SELECT * INTO v_participant FROM credit_card_purchase_split_participants WHERE id = v_item.participant_id;
				IF NOT FOUND THEN
					RAISE EXCEPTION 'Participant % not found for split item %', v_item.participant_id, v_item.id;
				END IF;

				SELECT * INTO v_obl FROM person_obligations WHERE id = v_participant.person_obligation_id;
				IF NOT FOUND THEN
					RAISE EXCEPTION 'Obligation % not found for participant %', v_participant.person_obligation_id, v_participant.id;
				END IF;

				IF v_obl.direction != 'RECEIVABLE' OR v_obl.person_id != v_item.person_id OR v_obl.user_id != v_split.user_id THEN
					RAISE EXCEPTION 'Obligation % does not match split participant (direction/person/user)', v_obl.id;
				END IF;

				SELECT * INTO v_obl_rev
				FROM person_obligation_revisions
				WHERE obligation_id = v_obl.id
				ORDER BY revision_no DESC
				LIMIT 1;

				IF v_obl_rev IS NULL OR v_obl_rev.operation = 'VOID' THEN
					RAISE EXCEPTION 'Active split item obligation % is void or missing', v_obl.id;
				END IF;

				IF v_obl_rev.principal_amount != v_item.share_amount THEN
					RAISE EXCEPTION 'Active split item obligation % principal % does not match item share_amount %',
						v_obl.id, v_obl_rev.principal_amount, v_item.share_amount;
				END IF;
			END LOOP;

			-- Check inactive/removed participants on this split have their obligations voided
			FOR v_inactive_participant IN
				SELECT p.*
				FROM credit_card_purchase_split_participants p
				WHERE p.split_id = v_split.id
				  AND p.id NOT IN (
					SELECT participant_id FROM credit_card_purchase_split_revision_items WHERE split_revision_id = v_latest_split_rev.id
				  )
			LOOP
				SELECT * INTO v_inactive_obl_rev
				FROM person_obligation_revisions
				WHERE obligation_id = v_inactive_participant.person_obligation_id
				ORDER BY revision_no DESC
				LIMIT 1;

				IF v_inactive_obl_rev IS NOT NULL AND v_inactive_obl_rev.operation != 'VOID' THEN
					RAISE EXCEPTION 'Removed split participant % obligation % must be VOID',
						v_inactive_participant.id, v_inactive_participant.person_obligation_id;
				END IF;
			END LOOP;

			-- Check underlying purchase latest revision
			SELECT * INTO v_latest_purchase_rev
			FROM credit_card_liability_event_revisions
			WHERE event_id = v_split.purchase_event_id
			ORDER BY revision_no DESC
			LIMIT 1;

			IF v_latest_purchase_rev IS NULL OR v_latest_purchase_rev.operation = 'VOID' THEN
				RAISE EXCEPTION 'Active split % cannot exist for voided purchase %', v_split.id, v_split.purchase_event_id;
			END IF;

			IF v_latest_split_rev.purchase_event_revision_id != v_latest_purchase_rev.id THEN
				RAISE EXCEPTION 'Active split % purchase_event_revision_id % does not match latest purchase revision id %',
					v_split.id, v_latest_split_rev.purchase_event_revision_id, v_latest_purchase_rev.id;
			END IF;
		END IF;
	END LOOP;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_split_commit_check_splits ON "credit_card_purchase_splits";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_split_commit_check_splits
AFTER INSERT ON "credit_card_purchase_splits"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_split_commit_check();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_split_commit_check_revisions ON "credit_card_purchase_split_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_split_commit_check_revisions
AFTER INSERT ON "credit_card_purchase_split_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_split_commit_check();--> statement-breakpoint

-- Trigger on purchase event revisions to detect raw purchase mutations bypassing coordinated split update
CREATE OR REPLACE FUNCTION trg_fn_guard_cc_purchase_split_binding_check()
RETURNS TRIGGER AS $$
DECLARE
	v_split RECORD;
	v_latest_split_rev RECORD;
BEGIN
	SELECT * INTO v_split FROM credit_card_purchase_splits WHERE purchase_event_id = NEW.event_id;
	IF FOUND THEN
		SELECT * INTO v_latest_split_rev
		FROM credit_card_purchase_split_revisions
		WHERE split_id = v_split.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF v_latest_split_rev IS NOT NULL AND v_latest_split_rev.operation != 'VOID' THEN
			IF NEW.operation = 'VOID' THEN
				RAISE EXCEPTION 'Cannot void purchase % while active split % exists', NEW.event_id, v_split.id;
			END IF;
			IF v_latest_split_rev.purchase_event_revision_id != NEW.id THEN
				RAISE EXCEPTION 'Purchase % latest revision % does not match active split % purchase_event_revision_id %',
					NEW.event_id, NEW.id, v_split.id, v_latest_split_rev.purchase_event_revision_id;
			END IF;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_purchase_split_binding_check ON "credit_card_liability_event_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_purchase_split_binding_check
AFTER INSERT ON "credit_card_liability_event_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_purchase_split_binding_check();
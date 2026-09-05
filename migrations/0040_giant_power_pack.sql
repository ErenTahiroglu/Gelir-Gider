-- Custom SQL migration file, put your code below! --

-- ============================================================================
-- PHASE 12-R2: REWARDS REDEMPTION CATEGORY COMPLETENESS, EXACT CANONICAL
-- PAYLOAD KEY SET & OPENING BALANCE CORRECTION SEMANTICS
--
-- A. Drops all-time unique index on reward_events(reward_account_id) WHERE event_type = 'OPENING_BALANCE'.
-- B. Serializes active opening balance enforcement inside trg_fn_guard_reward_event_revision_insert
--    via reward account FOR UPDATE lock: at most ONE active (non-VOID) opening event per account.
-- C. Enforces purchase_category NOT NULL for REDEEM_PURCHASE revisions and removes COALESCE fallback.
-- D. Enforces exact 9-key canonical payload key set for REWARD_FUNDED_PURCHASE canonical transactions.
-- ============================================================================

DROP INDEX IF EXISTS "reward_events_account_opening_idx";--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_event_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_account RECORD;
	v_latest_account_status TEXT;
	v_latest RECORD;
	v_other_active_opening_id UUID;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_invalid_key TEXT;
	v_expected_role TEXT;
	v_expense_account RECORD;
	v_reward_benefit_account RECORD;
	v_user_currency TEXT;
	v_line_count INT;
	v_debit_line RECORD;
	v_credit_line RECORD;
	v_expected_economic NUMERIC;
	v_goal RECORD;
	v_goal_status TEXT;
BEGIN
	SELECT * INTO v_event FROM reward_events WHERE id = NEW.reward_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward event % not found', NEW.reward_event_id;
	END IF;
	IF v_event.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reward event user_id % does not match revision user_id %', v_event.user_id, NEW.user_id;
	END IF;

	-- Lock the owning reward account and require it ACTIVE for any FRESH
	-- mutation (a historical exact-idempotent replay never reaches this
	-- trigger, since the service layer returns the replay without inserting).
	SELECT * INTO v_account FROM reward_accounts WHERE id = v_event.reward_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward account % not found for event %', v_event.reward_account_id, NEW.reward_event_id;
	END IF;

	-- Explicit same-user ownership recheck before any point/canonical work
	-- (defense in depth alongside the reward_events BEFORE INSERT anchor
	-- guard, which already rejects this at event-creation time).
	IF v_account.user_id != v_event.user_id THEN
		RAISE EXCEPTION 'Reward account % user_id % does not match reward event % user_id %',
			v_account.id, v_account.user_id, v_event.id, v_event.user_id;
	END IF;

	SELECT status INTO v_latest_account_status
	FROM reward_account_revisions
	WHERE reward_account_id = v_account.id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF v_latest_account_status IS DISTINCT FROM 'ACTIVE' THEN
		RAISE EXCEPTION 'Cannot mutate reward event for non-ACTIVE reward account %', v_account.id;
	END IF;

	-- Chain integrity: revision #1 must be CREATE; the only other permitted
	-- operation is a single terminal VOID (no UPDATE in V1).
	SELECT id, revision_no, operation, point_amount, conversion_rate, economic_amount,
		purchase_category, short_term_goal_id, merchant, description, occurred_at,
		source_type, source_ref
	INTO v_latest
	FROM reward_event_revisions
	WHERE reward_event_id = NEW.reward_event_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Reward event % already has revisions; revision 1 cannot be created again', NEW.reward_event_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;

		-- OPENING_BALANCE serialized active-opening check:
		-- After acquiring the reward account FOR UPDATE lock, verify that no
		-- other OPENING_BALANCE event for this account has a latest revision
		-- whose operation != 'VOID'.
		IF v_event.event_type = 'OPENING_BALANCE' THEN
			SELECT re.id INTO v_other_active_opening_id
			FROM reward_events re
			WHERE re.reward_account_id = v_account.id
				AND re.event_type = 'OPENING_BALANCE'
				AND re.id != v_event.id
				AND (
					SELECT rer.operation
					FROM reward_event_revisions rer
					WHERE rer.reward_event_id = re.id
					ORDER BY rer.revision_no DESC
					LIMIT 1
				) != 'VOID';

			IF v_other_active_opening_id IS NOT NULL THEN
				RAISE EXCEPTION 'Reward account % already has an active OPENING_BALANCE event %', v_account.id, v_other_active_opening_id;
			END IF;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for reward event %', NEW.reward_event_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of reward event % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.reward_event_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID reward event % (VOID is terminal)', NEW.reward_event_id;
		END IF;
		IF NEW.operation != 'VOID' THEN
			RAISE EXCEPTION 'Only VOID is permitted as a subsequent reward event revision, found %', NEW.operation;
		END IF;

		-- VOID snapshot immutability: every immutable economic/unit/
		-- provenance field must copy forward EXACTLY from the previous
		-- (CREATE) revision. Only reason_note may differ (the VOID reason),
		-- and idempotency_key/revision_fingerprint naturally differ.
		IF NEW.point_amount != v_latest.point_amount THEN
			RAISE EXCEPTION 'VOID revision must copy forward point_amount exactly (expected %, found %)', v_latest.point_amount, NEW.point_amount;
		END IF;
		IF NEW.conversion_rate != v_latest.conversion_rate THEN
			RAISE EXCEPTION 'VOID revision must copy forward conversion_rate exactly (expected %, found %)', v_latest.conversion_rate, NEW.conversion_rate;
		END IF;
		IF NEW.economic_amount IS DISTINCT FROM v_latest.economic_amount THEN
			RAISE EXCEPTION 'VOID revision must copy forward economic_amount exactly';
		END IF;
		IF NEW.purchase_category IS DISTINCT FROM v_latest.purchase_category THEN
			RAISE EXCEPTION 'VOID revision must copy forward purchase_category exactly';
		END IF;
		IF NEW.short_term_goal_id IS DISTINCT FROM v_latest.short_term_goal_id THEN
			RAISE EXCEPTION 'VOID revision must copy forward short_term_goal_id exactly';
		END IF;
		IF NEW.merchant IS DISTINCT FROM v_latest.merchant THEN
			RAISE EXCEPTION 'VOID revision must copy forward merchant exactly';
		END IF;
		IF NEW.description IS DISTINCT FROM v_latest.description THEN
			RAISE EXCEPTION 'VOID revision must copy forward description exactly';
		END IF;
		IF NEW.occurred_at != v_latest.occurred_at THEN
			RAISE EXCEPTION 'VOID revision must copy forward occurred_at exactly (expected %, found %)', v_latest.occurred_at, NEW.occurred_at;
		END IF;
		IF NEW.source_type != v_latest.source_type THEN
			RAISE EXCEPTION 'VOID revision must copy forward source_type exactly (expected %, found %)', v_latest.source_type, NEW.source_type;
		END IF;
		IF NEW.source_ref IS DISTINCT FROM v_latest.source_ref THEN
			RAISE EXCEPTION 'VOID revision must copy forward source_ref exactly';
		END IF;
	END IF;

	-- Non-economic vs redemption field consistency, per event_type.
	IF v_event.event_type != 'REDEEM_PURCHASE' THEN
		IF NEW.economic_amount IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have economic_amount NULL', NEW.reward_event_id;
		END IF;
		IF NEW.purchase_category IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have purchase_category NULL', NEW.reward_event_id;
		END IF;
		IF NEW.short_term_goal_id IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have short_term_goal_id NULL', NEW.reward_event_id;
		END IF;
		IF NEW.canonical_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have canonical_revision_id NULL', NEW.reward_event_id;
		END IF;
	ELSE
		IF NEW.economic_amount IS NULL THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % requires economic_amount', NEW.reward_event_id;
		END IF;
		IF NEW.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % requires canonical_revision_id', NEW.reward_event_id;
		END IF;
		IF NEW.purchase_category IS NULL THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % requires purchase_category', NEW.reward_event_id;
		END IF;
		IF NEW.purchase_category NOT IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED') THEN
			RAISE EXCEPTION 'Reward purchase has unknown purchase_category %', NEW.purchase_category;
		END IF;

		-- Economic amount is mathematically authoritative: it is not enough
		-- that payload/projection/journal agree with each other -- the
		-- value itself must equal the deterministic ROUND HALF UP
		-- derivation from point_amount and conversion_rate.
		v_expected_economic := floor(NEW.point_amount * NEW.conversion_rate * 100 + 0.5) / 100;
		IF NEW.economic_amount != v_expected_economic THEN
			RAISE EXCEPTION 'Reward event % economic_amount % does not match authoritative derivation % (point_amount % x conversion_rate %)',
				NEW.reward_event_id, NEW.economic_amount, v_expected_economic, NEW.point_amount, NEW.conversion_rate;
		END IF;

		-- Exact canonical revision binding.
		SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
		END IF;
		IF v_can_rev.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Canonical revision user_id % does not match reward event revision user_id %', v_can_rev.user_id, NEW.user_id;
		END IF;
		IF v_can_rev.transaction_id != v_event.canonical_transaction_id THEN
			RAISE EXCEPTION 'Canonical revision transaction_id % does not match reward event canonical_transaction_id %',
				v_can_rev.transaction_id, v_event.canonical_transaction_id;
		END IF;
		IF v_can_rev.operation != NEW.operation THEN
			RAISE EXCEPTION 'Canonical revision operation % does not match reward event revision operation %',
				v_can_rev.operation, NEW.operation;
		END IF;
		IF v_can_rev.occurred_at != NEW.occurred_at THEN
			RAISE EXCEPTION 'Canonical revision occurred_at % does not match reward event revision occurred_at %',
				v_can_rev.occurred_at, NEW.occurred_at;
		END IF;

		SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
		END IF;
		IF v_can_tx.kind != 'REWARD_FUNDED_PURCHASE' THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % canonical transaction % has wrong kind %',
				NEW.reward_event_id, v_can_tx.id, v_can_tx.kind;
		END IF;

		-- Exact 9-key canonical payload validation: length, existence, and exact matching.
		IF jsonb_typeof(v_can_rev.payload) != 'object' OR (SELECT count(*) FROM jsonb_object_keys(v_can_rev.payload)) != 9 THEN
			RAISE EXCEPTION 'REWARD_FUNDED_PURCHASE canonical payload must contain exactly 9 keys, found %', (SELECT count(*) FROM jsonb_object_keys(v_can_rev.payload));
		END IF;

		IF NOT (v_can_rev.payload ?& ARRAY['rewardEventId', 'rewardAccountId', 'points', 'conversionRate', 'economicAmount', 'purchaseCategory', 'shortTermGoalId', 'merchant', 'description']) THEN
			RAISE EXCEPTION 'REWARD_FUNDED_PURCHASE canonical payload is missing required keys';
		END IF;

		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('rewardEventId', 'rewardAccountId', 'points', 'conversionRate', 'economicAmount', 'purchaseCategory', 'shortTermGoalId', 'merchant', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in REWARD_FUNDED_PURCHASE canonical payload', v_invalid_key;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'rewardEventId') != 'string' OR
		   v_can_rev.payload->>'rewardEventId' != NEW.reward_event_id::text THEN
			RAISE EXCEPTION 'Canonical payload rewardEventId % does not match reward event %',
				v_can_rev.payload->>'rewardEventId', NEW.reward_event_id;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'rewardAccountId') != 'string' OR
		   v_can_rev.payload->>'rewardAccountId' != v_event.reward_account_id::text THEN
			RAISE EXCEPTION 'Canonical payload rewardAccountId % does not match reward account %',
				v_can_rev.payload->>'rewardAccountId', v_event.reward_account_id;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'points') != 'string' OR
		   v_can_rev.payload->>'points' != NEW.point_amount::text THEN
			RAISE EXCEPTION 'Canonical payload points % does not match revision point_amount %',
				v_can_rev.payload->>'points', NEW.point_amount;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'conversionRate') != 'string' OR
		   v_can_rev.payload->>'conversionRate' != NEW.conversion_rate::text THEN
			RAISE EXCEPTION 'Canonical payload conversionRate % does not match revision conversion_rate %',
				v_can_rev.payload->>'conversionRate', NEW.conversion_rate;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'economicAmount') != 'string' OR
		   v_can_rev.payload->>'economicAmount' != NEW.economic_amount::text THEN
			RAISE EXCEPTION 'Canonical payload economicAmount % does not match revision economic_amount %',
				v_can_rev.payload->>'economicAmount', NEW.economic_amount;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'purchaseCategory') != 'string' OR
		   v_can_rev.payload->>'purchaseCategory' != NEW.purchase_category THEN
			RAISE EXCEPTION 'Canonical payload purchaseCategory % does not match revision purchase_category %',
				v_can_rev.payload->>'purchaseCategory', NEW.purchase_category;
		END IF;

		IF NEW.short_term_goal_id IS NULL THEN
			IF jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload shortTermGoalId must be null when revision short_term_goal_id is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'string' OR
			   v_can_rev.payload->>'shortTermGoalId' != NEW.short_term_goal_id::text THEN
				RAISE EXCEPTION 'Canonical payload shortTermGoalId % does not match revision short_term_goal_id %',
					v_can_rev.payload->>'shortTermGoalId', NEW.short_term_goal_id;
			END IF;
		END IF;

		IF NEW.merchant IS NULL THEN
			IF jsonb_typeof(v_can_rev.payload->'merchant') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload merchant must be null when revision merchant is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'merchant') != 'string' OR
			   v_can_rev.payload->>'merchant' != NEW.merchant THEN
				RAISE EXCEPTION 'Canonical payload merchant % does not match revision merchant %',
					v_can_rev.payload->>'merchant', NEW.merchant;
			END IF;
		END IF;

		IF NEW.description IS NULL THEN
			IF jsonb_typeof(v_can_rev.payload->'description') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload description must be null when revision description is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'description') != 'string' OR
			   v_can_rev.payload->>'description' != NEW.description THEN
				RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
					v_can_rev.payload->>'description', NEW.description;
			END IF;
		END IF;

		-- Fresh CREATE only: goal binding + exact ledger binding.
		IF NEW.operation = 'CREATE' THEN
			-- DB-authoritative short-term goal binding: category and goal
			-- presence/ownership/status are cross-checked independently of
			-- the application layer.
			IF NEW.purchase_category = 'SHORT_TERM_PURCHASE' THEN
				IF NEW.short_term_goal_id IS NULL THEN
					RAISE EXCEPTION 'Reward purchase % with category SHORT_TERM_PURCHASE requires short_term_goal_id', NEW.reward_event_id;
				END IF;
				SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.short_term_goal_id;
				IF NOT FOUND THEN
					RAISE EXCEPTION 'Short-term goal % not found', NEW.short_term_goal_id;
				END IF;
				IF v_goal.user_id != NEW.user_id THEN
					RAISE EXCEPTION 'Short-term goal % belongs to a different user than reward event %', NEW.short_term_goal_id, NEW.reward_event_id;
				END IF;
				SELECT status INTO v_goal_status
				FROM short_term_goal_revisions
				WHERE goal_id = NEW.short_term_goal_id
				ORDER BY revision_no DESC
				LIMIT 1;
				IF v_goal_status IS DISTINCT FROM 'ACTIVE' THEN
					RAISE EXCEPTION 'Short-term goal % is not ACTIVE (found %)', NEW.short_term_goal_id, v_goal_status;
				END IF;
			ELSE
				IF NEW.short_term_goal_id IS NOT NULL THEN
					RAISE EXCEPTION 'Reward purchase % with category % must not have short_term_goal_id', NEW.reward_event_id, NEW.purchase_category;
				END IF;
			END IF;

			-- Exact ledger binding: the applied journal must contain
			-- EXACTLY two lines -- Dr the authoritative system expense
			-- account for purchase_category, Cr the REWARD_BENEFIT account
			-- -- each for exactly economic_amount.
			v_expected_role := CASE NEW.purchase_category
				WHEN 'MANDATORY_EXPENSE' THEN 'MANDATORY_EXPENSE'
				WHEN 'DISCRETIONARY_SPEND' THEN 'DISCRETIONARY_EXPENSE'
				WHEN 'SHORT_TERM_PURCHASE' THEN 'SHORT_TERM_PURCHASE'
				WHEN 'UNCLASSIFIED' THEN 'UNCLASSIFIED_EXPENSE'
				ELSE NULL
			END;
			IF v_expected_role IS NULL THEN
				RAISE EXCEPTION 'Reward purchase has unknown purchase_category %', NEW.purchase_category;
			END IF;

			SELECT u.currency INTO v_user_currency FROM users u WHERE u.id = NEW.user_id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'User % not found', NEW.user_id;
			END IF;

			SELECT la.* INTO v_expense_account
			FROM credit_card_system_accounts ccsa
			JOIN ledger_accounts la ON la.id = ccsa.ledger_account_id
			WHERE ccsa.user_id = NEW.user_id AND ccsa.role = v_expected_role;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'No system expense account provisioned for role % (user %)', v_expected_role, NEW.user_id;
			END IF;
			IF v_expense_account.user_id != NEW.user_id THEN
				RAISE EXCEPTION 'Authoritative expense account % does not belong to user %', v_expense_account.id, NEW.user_id;
			END IF;
			IF v_expense_account.account_type != 'EXPENSE' OR v_expense_account.normal_balance != 'DEBIT' THEN
				RAISE EXCEPTION 'Authoritative expense account % is not a valid EXPENSE/DEBIT account (type %, normal_balance %)',
					v_expense_account.id, v_expense_account.account_type, v_expense_account.normal_balance;
			END IF;
			IF v_expense_account.currency != v_user_currency THEN
				RAISE EXCEPTION 'Authoritative expense account % currency % does not match user currency %',
					v_expense_account.id, v_expense_account.currency, v_user_currency;
			END IF;
			IF v_expense_account.archived_at IS NOT NULL THEN
				RAISE EXCEPTION 'Authoritative expense account % is archived', v_expense_account.id;
			END IF;

			SELECT la.* INTO v_reward_benefit_account
			FROM ledger_accounts la WHERE la.user_id = NEW.user_id AND la.code = 'SYS_REWARD_BENEFIT';
			IF NOT FOUND THEN
				RAISE EXCEPTION 'No REWARD_BENEFIT system account provisioned (user %)', NEW.user_id;
			END IF;
			IF v_reward_benefit_account.account_type != 'INCOME' OR v_reward_benefit_account.normal_balance != 'CREDIT' THEN
				RAISE EXCEPTION 'REWARD_BENEFIT account % is not a valid INCOME/CREDIT account (type %, normal_balance %)',
					v_reward_benefit_account.id, v_reward_benefit_account.account_type, v_reward_benefit_account.normal_balance;
			END IF;
			IF v_reward_benefit_account.currency != v_user_currency THEN
				RAISE EXCEPTION 'REWARD_BENEFIT account % currency % does not match user currency %',
					v_reward_benefit_account.id, v_reward_benefit_account.currency, v_user_currency;
			END IF;
			IF v_reward_benefit_account.archived_at IS NOT NULL THEN
				RAISE EXCEPTION 'REWARD_BENEFIT account % is archived', v_reward_benefit_account.id;
			END IF;

			SELECT count(*) INTO v_line_count
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id;

			IF v_line_count != 2 THEN
				RAISE EXCEPTION 'Reward purchase % applied journal must have exactly 2 lines, found %',
					NEW.reward_event_id, v_line_count;
			END IF;

			SELECT jl.* INTO v_debit_line
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id AND jl.debit > 0;

			SELECT jl.* INTO v_credit_line
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id AND jl.credit > 0;

			IF v_debit_line IS NULL OR v_credit_line IS NULL THEN
				RAISE EXCEPTION 'Reward purchase % applied journal must have exactly one debit line and one credit line', NEW.reward_event_id;
			END IF;
			IF v_debit_line.account_id != v_expense_account.id THEN
				RAISE EXCEPTION 'Reward purchase % debit line account % is not the authoritative expense account %',
					NEW.reward_event_id, v_debit_line.account_id, v_expense_account.id;
			END IF;
			IF v_credit_line.account_id != v_reward_benefit_account.id THEN
				RAISE EXCEPTION 'Reward purchase % credit line account % is not the REWARD_BENEFIT account %',
					NEW.reward_event_id, v_credit_line.account_id, v_reward_benefit_account.id;
			END IF;
			IF v_debit_line.debit != NEW.economic_amount THEN
				RAISE EXCEPTION 'Reward purchase % debit amount % does not match economic_amount %',
					NEW.reward_event_id, v_debit_line.debit, NEW.economic_amount;
			END IF;
			IF v_credit_line.credit != NEW.economic_amount THEN
				RAISE EXCEPTION 'Reward purchase % credit amount % does not match economic_amount %',
					NEW.reward_event_id, v_credit_line.credit, NEW.economic_amount;
			END IF;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
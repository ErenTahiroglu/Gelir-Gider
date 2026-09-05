-- Custom SQL migration file, put your code below! --

-- ============================================================================
-- PHASE 12-R1: REWARDS OWNERSHIP, VALUATION, PROVENANCE & DB-INTEGRITY
-- HARDENING
--
-- A. Same-user ownership at DB level: reward account <-> credit card,
--    reward event <-> reward account (BEFORE INSERT anchor guards, plus a
--    recheck inside the revision guard before any point/canonical work).
-- B. Economic amount mathematically authoritative: DB-derived formula
--    (economic_amount = ROUND_HALF_UP(point_amount * conversion_rate, 2)),
--    independently verified rather than trusted from the application.
-- C. DB-authoritative short-term goal binding for REDEEM_PURCHASE CREATE.
-- D. VOID / ARCHIVE snapshot immutability: exact copy-forward of every
--    immutable economic/unit/config field from the previous revision.
-- E. Exact REWARD_BENEFIT / authoritative expense account ledger contract
--    validation (account_type, normal_balance, currency, unarchived).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A1. REWARD ACCOUNT <-> CREDIT CARD SAME-USER OWNERSHIP (BEFORE INSERT)
--     Card may be ARCHIVED -- usability is never gated on card status.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_account_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_card RECORD;
BEGIN
	IF NEW.credit_card_id IS NOT NULL THEN
		SELECT * INTO v_card FROM credit_cards WHERE id = NEW.credit_card_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card % not found', NEW.credit_card_id;
		END IF;
		IF v_card.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Credit card % belongs to a different user than reward account %', NEW.credit_card_id, NEW.id;
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_account_insert ON "reward_accounts";--> statement-breakpoint
CREATE TRIGGER trg_guard_reward_account_insert
BEFORE INSERT ON "reward_accounts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_account_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- A2. REWARD EVENT <-> REWARD ACCOUNT SAME-USER OWNERSHIP (BEFORE INSERT)
--     A user A reward event must NEVER be able to affect user B's reward
--     account balance -- this is mandatory because point-balance
--     reconciliation derives the balance purely by reward_account_id.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_event_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_account RECORD;
BEGIN
	SELECT * INTO v_account FROM reward_accounts WHERE id = NEW.reward_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
	END IF;
	IF v_account.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reward account % belongs to a different user than reward event %', NEW.reward_account_id, NEW.id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_event_insert ON "reward_events";--> statement-breakpoint
CREATE TRIGGER trg_guard_reward_event_insert
BEFORE INSERT ON "reward_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_event_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- D1. REWARD ACCOUNT REVISION GUARD: ADD ARCHIVE COPY-FORWARD IMMUTABILITY
--     (replaces the Phase 12 version; chain/status logic unchanged)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_account_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_account RECORD;
	v_latest RECORD;
BEGIN
	SELECT * INTO v_account FROM reward_accounts WHERE id = NEW.reward_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
	END IF;
	IF v_account.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reward account user_id % does not match revision user_id %', v_account.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no, operation, status, display_name, provider, unit_name, default_conversion_rate, note
	INTO v_latest
	FROM reward_account_revisions
	WHERE reward_account_id = NEW.reward_account_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Reward account % already has revisions; revision 1 cannot be created again', NEW.reward_account_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'First revision must have status ACTIVE, found %', NEW.status;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for reward account %', NEW.reward_account_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of reward account % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.reward_account_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'ARCHIVE' THEN
			RAISE EXCEPTION 'Cannot create revision on ARCHIVED reward account % (ARCHIVE is terminal)', NEW.reward_account_id;
		END IF;
		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		END IF;
		IF NEW.operation = 'UPDATE' AND NEW.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'UPDATE revision must keep status ACTIVE, found %', NEW.status;
		END IF;
		IF NEW.operation = 'ARCHIVE' THEN
			IF NEW.status != 'ARCHIVED' THEN
				RAISE EXCEPTION 'ARCHIVE revision must set status ARCHIVED, found %', NEW.status;
			END IF;
			-- ARCHIVE is a lifecycle-only revision: mutable config must copy
			-- forward exactly from the previous revision.
			IF NEW.display_name != v_latest.display_name THEN
				RAISE EXCEPTION 'ARCHIVE revision must copy forward display_name exactly (expected %, found %)', v_latest.display_name, NEW.display_name;
			END IF;
			IF NEW.provider != v_latest.provider THEN
				RAISE EXCEPTION 'ARCHIVE revision must copy forward provider exactly (expected %, found %)', v_latest.provider, NEW.provider;
			END IF;
			IF NEW.unit_name != v_latest.unit_name THEN
				RAISE EXCEPTION 'ARCHIVE revision must copy forward unit_name exactly (expected %, found %)', v_latest.unit_name, NEW.unit_name;
			END IF;
			IF NEW.default_conversion_rate != v_latest.default_conversion_rate THEN
				RAISE EXCEPTION 'ARCHIVE revision must copy forward default_conversion_rate exactly (expected %, found %)', v_latest.default_conversion_rate, NEW.default_conversion_rate;
			END IF;
			IF NEW.note IS DISTINCT FROM v_latest.note THEN
				RAISE EXCEPTION 'ARCHIVE revision must copy forward note exactly';
			END IF;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- (trigger itself already exists from migration 0038 and is unaffected by a
-- CREATE OR REPLACE FUNCTION of its underlying function body)

-- ----------------------------------------------------------------------------
-- B/C/D2/E. REWARD EVENT REVISION GUARD: REPLACE WITH ALL HARDENING ADDED
--     - Recheck reward_account_id ownership before any point/canonical work.
--     - VOID must copy forward every immutable snapshot field exactly.
--     - economic_amount must equal ROUND_HALF_UP(point_amount *
--       conversion_rate, 2), independently derived, not merely compared
--       across payload/journal/projection.
--     - REDEEM_PURCHASE CREATE requires an exact, DB-verified short-term
--       goal binding when purchase_category = SHORT_TERM_PURCHASE, and
--       forbids one otherwise.
--     - The authoritative expense account and the REWARD_BENEFIT account
--       are validated against their full ledger contract (same user,
--       correct account_type/normal_balance/currency, unarchived) rather
--       than resolved by code alone.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_event_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_account RECORD;
	v_latest_account_status TEXT;
	v_latest RECORD;
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

		-- Economic amount is mathematically authoritative: it is not enough
		-- that payload/projection/journal agree with each other -- the
		-- value itself must equal the deterministic ROUND HALF UP
		-- derivation from point_amount and conversion_rate. Using
		-- floor(x * 100 + 0.5) / 100 on exact NUMERIC arithmetic (never
		-- float) reproduces the application's half-up-away-from-zero
		-- semantics precisely for these always-positive inputs.
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

		-- Exact canonical payload binding: whitelist + exact values.
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

		IF NEW.purchase_category IS NULL THEN
			IF v_can_rev.payload->'purchaseCategory' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'purchaseCategory') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload purchaseCategory must be null when revision purchase_category is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'purchaseCategory') != 'string' OR
			   v_can_rev.payload->>'purchaseCategory' != NEW.purchase_category THEN
				RAISE EXCEPTION 'Canonical payload purchaseCategory % does not match revision purchase_category %',
					v_can_rev.payload->>'purchaseCategory', NEW.purchase_category;
			END IF;
		END IF;

		IF NEW.short_term_goal_id IS NULL THEN
			IF v_can_rev.payload->'shortTermGoalId' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'null' THEN
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
			IF v_can_rev.payload->'merchant' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'merchant') != 'null' THEN
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
			IF v_can_rev.payload->'description' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'description') != 'null' THEN
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
			-- -- each for exactly economic_amount. No third line, no
			-- ASSET/CREDIT_CARD_LIABILITY/MIDAS/person account may ever
			-- appear. Both accounts are validated against their full
			-- ledger contract, not merely resolved by role/code lookup.
			v_expected_role := CASE COALESCE(NEW.purchase_category, 'UNCLASSIFIED')
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
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- (trigger itself already exists from migration 0038 and is unaffected by a
-- CREATE OR REPLACE FUNCTION of its underlying function body)

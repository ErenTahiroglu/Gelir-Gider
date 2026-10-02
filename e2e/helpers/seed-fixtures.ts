import crypto from "node:crypto";
import { getPreviousIstanbulPeriodMonth } from "../../frontend/src/lib/istanbul-date";
import type { ServerInstance } from "./test-server";

export interface SeededPrerequisites {
	userId: string;
	assetAccountId: string;
	cardId: string;
	statementId: string;
	personId: string;
	obligationId: string;
	previousPeriodMonth: string;
}

export async function seedE2EPrerequisites(
	serverInstance: ServerInstance,
	userId?: string,
): Promise<SeededPrerequisites> {
	const db = serverInstance.dbClient;
	const isRealPg = serverInstance.isRealPg;

	const now = new Date();
	const prevMonth = getPreviousIstanbulPeriodMonth();
	const [cycleYearStr, cycleMonthStr] = prevMonth.split("-");
	const cycleYear = Number.parseInt(cycleYearStr ?? "2026", 10);
	const cycleMonth = Number.parseInt(cycleMonthStr ?? "9", 10);

	const runSql = async (sql: string, params: any[] = []) => {
		if (isRealPg) {
			return db.query(sql, params);
		}
		return db.query(sql, params);
	};

	let resolvedUserId = userId;
	if (!resolvedUserId) {
		const userRes = await runSql("SELECT id FROM users LIMIT 1");
		const rows = userRes?.rows ?? userRes ?? [];
		resolvedUserId = rows[0]?.id;
	}

	if (!resolvedUserId) {
		throw new Error("No user found in database to seed prerequisites for");
	}

	const fp64 = "a".repeat(64);

	await runSql("SET session_replication_role = replica;");

	try {
		// 1. Ledger Accounts (Asset, Equity, Midas, Card Liability, Person Rec/Pay)
		const assetAccountId = crypto.randomUUID();
		const sermayeAccountId = crypto.randomUUID();
		const midasLedgerAccountId = crypto.randomUUID();
		const cardLiabilityAccountId = crypto.randomUUID();
		const personId = crypto.randomUUID();
		const personSuffix = personId.replace(/-/g, "").toUpperCase();
		const personRecAccountId = crypto.randomUUID();
		const personPayAccountId = crypto.randomUUID();

		await runSql(
			`INSERT INTO ledger_accounts (id, user_id, code, name, account_type, normal_balance, currency, created_at)
			 VALUES 
			 ($1, $2, 'VADESIZ_TL', 'Vadesiz TL Hesabı', 'ASSET', 'DEBIT', 'TRY', $3),
			 ($4, $2, 'SERMAYE_TL', 'Açılış Sermayesi', 'EQUITY', 'CREDIT', 'TRY', $3),
			 ($5, $2, 'MIDAS_TL', 'Midas Likidite Hesabı', 'ASSET', 'DEBIT', 'TRY', $3),
			 ($6, $2, 'CC_GARANTI_BONUS_LIABILITY', 'Garanti Bonus Borç Hesabı', 'LIABILITY', 'CREDIT', 'TRY', $3),
			 ($7, $2, $8, 'Ahmet Yılmaz Alacak', 'ASSET', 'DEBIT', 'TRY', $3),
			 ($9, $2, $10, 'Ahmet Yılmaz Borç', 'LIABILITY', 'CREDIT', 'TRY', $3)
			 ON CONFLICT (user_id, code) DO NOTHING`,
			[
				assetAccountId,
				resolvedUserId,
				now,
				sermayeAccountId,
				midasLedgerAccountId,
				cardLiabilityAccountId,
				personRecAccountId,
				`REC_${personSuffix}`.slice(0, 64),
				personPayAccountId,
				`PAY_${personSuffix}`.slice(0, 64),
			],
		);

		// 2. Journal Entry with balanced opening values:
		// Debit: 50,000.00 (Vadesiz TL) + 500.00 (Ahmet Yılmaz Alacak) = 50,500.00
		// Credit: 1,500.00 (Garanti Bonus Borç) + 49,000.00 (Sermaye) = 50,500.00
		const journalEntryId = crypto.randomUUID();
		await runSql(
			`INSERT INTO journal_entries (id, user_id, idempotency_key, posting_fingerprint, currency, occurred_at, status, posted_at, created_at)
			 VALUES ($1, $2, $3, $4, 'TRY', $5, 'POSTED', $5, $5)
			 ON CONFLICT DO NOTHING`,
			[journalEntryId, resolvedUserId, crypto.randomUUID(), fp64, now],
		);

		await runSql(
			`INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit, memo, created_at)
			 VALUES 
			 ($1, $2, 1, $3, 25000.00, 0.00, 'Açılış Nakit Bakiyesi', $4),
			 ($5, $2, 2, $6, 25000.00, 0.00, 'Midas Açılış Likiditesi', $4),
			 ($7, $2, 3, $8, 500.00, 0.00, 'Ahmet Yılmaz Açılış Alacağı', $4),
			 ($9, $2, 4, $10, 0.00, 1500.00, 'Kredi Kartı Dönem Borcu', $4),
			 ($11, $2, 5, $12, 0.00, 49000.00, 'Açılış Sermayesi Denge', $4)
			 ON CONFLICT DO NOTHING`,
			[
				crypto.randomUUID(),
				journalEntryId,
				assetAccountId,
				now,
				crypto.randomUUID(),
				midasLedgerAccountId,
				crypto.randomUUID(),
				personRecAccountId,
				crypto.randomUUID(),
				cardLiabilityAccountId,
				crypto.randomUUID(),
				sermayeAccountId,
			],
		);

		// 3. Midas Account & Buckets
		const midasAccountId = crypto.randomUUID();
		await runSql(
			`INSERT INTO midas_accounts (id, user_id, ledger_account_id, created_at)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT DO NOTHING`,
			[midasAccountId, resolvedUserId, midasLedgerAccountId, now],
		);

		const midasReserveBucketId = crypto.randomUUID();
		const midasMediumTermBucketId = crypto.randomUUID();
		await runSql(
			`INSERT INTO midas_buckets (id, midas_account_id, user_id, bucket_type, code, name, created_at)
			 VALUES 
			 ($1, $2, $3, 'CREDIT_CARD_RESERVE', 'RESERVE_GARANTI_BONUS', 'Garanti Reserve', $4),
			 ($5, $2, $3, 'MEDIUM_TERM_RESERVE', 'MEDIUM_TERM_RESERVE', 'Medium-Term Reserve', $4)
			 ON CONFLICT DO NOTHING`,
			[midasReserveBucketId, midasAccountId, resolvedUserId, now, midasMediumTermBucketId],
		);

		// 4. Credit Card + Link + Statement
		const cardId = crypto.randomUUID();
		await runSql(
			`INSERT INTO credit_cards (id, user_id, code, created_at)
			 VALUES ($1, $2, 'GARANTI_BONUS', $3)
			 ON CONFLICT DO NOTHING`,
			[cardId, resolvedUserId, now],
		);

		await runSql(
			`INSERT INTO credit_card_ledger_links (id, user_id, credit_card_id, ledger_account_id, created_at)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT DO NOTHING`,
			[crypto.randomUUID(), resolvedUserId, cardId, cardLiabilityAccountId, now],
		);

		await runSql(
			`INSERT INTO credit_card_revisions 
			 (id, user_id, credit_card_id, revision_no, operation, status, display_name, issuer, statement_day, due_day, credit_limit, occurred_at, idempotency_key, revision_fingerprint, created_at)
			 VALUES ($1, $2, $3, 1, 'CREATE', 'ACTIVE', 'Garanti Bonus', 'Garanti BBVA', 15, 25, 50000.00, $4, $5, $6, $4)
			 ON CONFLICT DO NOTHING`,
			[crypto.randomUUID(), resolvedUserId, cardId, now, crypto.randomUUID(), fp64],
		);

		const statementId = crypto.randomUUID();
		await runSql(
			`INSERT INTO credit_card_statements (id, user_id, credit_card_id, midas_account_id, midas_reserve_bucket_id, cycle_year, cycle_month, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 ON CONFLICT DO NOTHING`,
			[statementId, resolvedUserId, cardId, midasAccountId, midasReserveBucketId, cycleYear, cycleMonth, now],
		);

		await runSql(
			`INSERT INTO credit_card_statement_revisions 
			 (id, user_id, statement_id, revision_no, operation, status, statement_amount, statement_date, due_date, reserve_placement, occurred_at, idempotency_key, revision_fingerprint, created_at)
			 VALUES ($1, $2, $3, 1, 'CREATE', 'OPEN', 1500.00, $4, $5, 'OUTSIDE_MIDAS', $6, $7, $8, $6)
			 ON CONFLICT DO NOTHING`,
			[
				crypto.randomUUID(),
				resolvedUserId,
				statementId,
				`${prevMonth}-15`,
				`${prevMonth}-25`,
				now,
				crypto.randomUUID(),
				fp64,
			],
		);

		// 5. People + Link + Obligation
		await runSql(
			`INSERT INTO people (id, user_id, created_at)
			 VALUES ($1, $2, $3)
			 ON CONFLICT DO NOTHING`,
			[personId, resolvedUserId, now],
		);

		await runSql(
			`INSERT INTO person_ledger_links (id, user_id, person_id, receivable_account_id, payable_account_id, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT DO NOTHING`,
			[crypto.randomUUID(), resolvedUserId, personId, personRecAccountId, personPayAccountId, now],
		);

		await runSql(
			`INSERT INTO person_revisions 
			 (id, user_id, person_id, revision_no, operation, status, display_name, relationship, occurred_at, idempotency_key, revision_fingerprint, created_at)
			 VALUES ($1, $2, $3, 1, 'CREATE', 'ACTIVE', 'Ahmet Yılmaz', 'FRIEND', $4, $5, $6, $4)
			 ON CONFLICT DO NOTHING`,
			[crypto.randomUUID(), resolvedUserId, personId, now, crypto.randomUUID(), fp64],
		);

		const personTxId = crypto.randomUUID();
		await runSql(
			`INSERT INTO canonical_transactions (id, user_id, kind, creation_idempotency_key, creation_fingerprint, created_at)
			 VALUES ($1, $2, 'PEOPLE_RECEIVABLE', $3, $4, $5)
			 ON CONFLICT DO NOTHING`,
			[personTxId, resolvedUserId, crypto.randomUUID(), fp64, now],
		);

		const personTxRevId = crypto.randomUUID();
		await runSql(
			`INSERT INTO transaction_revisions (id, user_id, transaction_id, revision_no, operation, occurred_at, payload, revision_fingerprint, idempotency_key, created_at)
			 VALUES ($1, $2, $3, 1, 'CREATE', $4, '{}'::jsonb, $5, $6, $4)
			 ON CONFLICT DO NOTHING`,
			[personTxRevId, resolvedUserId, personTxId, now, fp64, crypto.randomUUID()],
		);

		const obligationId = crypto.randomUUID();
		await runSql(
			`INSERT INTO person_obligations (id, user_id, person_id, direction, canonical_transaction_id, created_at)
			 VALUES ($1, $2, $3, 'RECEIVABLE', $4, $5)
			 ON CONFLICT DO NOTHING`,
			[obligationId, resolvedUserId, personId, personTxId, now],
		);

		await runSql(
			`INSERT INTO person_obligation_revisions 
			 (id, user_id, obligation_id, revision_no, operation, principal_amount, occurred_at, canonical_revision_id, idempotency_key, revision_fingerprint, created_at)
			 VALUES ($1, $2, $3, 1, 'CREATE', 500.00, $4, $5, $6, $7, $4)
			 ON CONFLICT DO NOTHING`,
			[crypto.randomUUID(), resolvedUserId, obligationId, now, personTxRevId, crypto.randomUUID(), fp64],
		);

		// 6. Monthly Budget Plan for Previous Period Month
		const budgetTxId = crypto.randomUUID();
		await runSql(
			`INSERT INTO canonical_transactions (id, user_id, kind, creation_idempotency_key, creation_fingerprint, created_at)
			 VALUES ($1, $2, 'BUDGET_PLAN', $3, $4, $5)
			 ON CONFLICT DO NOTHING`,
			[budgetTxId, resolvedUserId, crypto.randomUUID(), fp64, now],
		);

		const budgetTxRevId = crypto.randomUUID();
		await runSql(
			`INSERT INTO transaction_revisions (id, user_id, transaction_id, revision_no, operation, occurred_at, payload, revision_fingerprint, idempotency_key, created_at)
			 VALUES ($1, $2, $3, 1, 'CREATE', $4, '{}'::jsonb, $5, $6, $4)
			 ON CONFLICT DO NOTHING`,
			[budgetTxRevId, resolvedUserId, budgetTxId, now, fp64, crypto.randomUUID()],
		);

		const budgetPlanId = crypto.randomUUID();
		await runSql(
			`INSERT INTO monthly_budget_plans (id, user_id, period_month, canonical_transaction_id, created_at)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT DO NOTHING`,
			[budgetPlanId, resolvedUserId, `${prevMonth}-01`, budgetTxId, now],
		);

		await runSql(
			`INSERT INTO monthly_budget_plan_revisions 
			 (id, user_id, budget_plan_id, canonical_revision_id, revision_no, operation, policy_version, currency, reference_income_amount, mandatory_ceiling_amount, discretionary_ceiling_amount, short_term_purchase_amount, medium_term_reserve_amount, long_term_investment_amount, reference_snapshot, created_at)
			 VALUES ($1, $2, $3, $4, 1, 'CREATE', 'PERSONAL_BUDGET_V1', 'TRY', 25000.00, 15000.00, 5000.00, 0.00, 0.00, 5000.00, '{}'::jsonb, $5)
			 ON CONFLICT DO NOTHING`,
			[crypto.randomUUID(), resolvedUserId, budgetPlanId, budgetTxRevId, now],
		);

		// 7. Spending Categories & Quick Entry Templates
		await runSql(
			`INSERT INTO spending_categories (id, user_id, name, default_budget_category, status, sort_order, created_at, updated_at)
			 VALUES ($1, $2, 'Market', 'MANDATORY_EXPENSE', 'ACTIVE', 1, $3, $3)
			 ON CONFLICT DO NOTHING`,
			[crypto.randomUUID(), resolvedUserId, now],
		);

		await runSql(
			`INSERT INTO quick_entry_templates (id, user_id, name, template_type, config, sort_order, status, created_at, updated_at)
			 VALUES ($1, $2, 'Market Harcaması', 'MANUAL_EXPENSE', $3::jsonb, 1, 'ACTIVE', $4, $4)
			 ON CONFLICT DO NOTHING`,
			[
				crypto.randomUUID(),
				resolvedUserId,
				JSON.stringify({
					sourceAssetAccountId: assetAccountId,
					defaultAmount: "125.50",
					description: "Haftalık Market",
					budgetCategoryOverride: "MANDATORY_EXPENSE",
				}),
				now,
			],
		);

		return {
			userId: resolvedUserId,
			assetAccountId,
			cardId,
			statementId,
			personId,
			obligationId,
			previousPeriodMonth: prevMonth,
		};
	} finally {
		await runSql("SET session_replication_role = origin;");
	}
}

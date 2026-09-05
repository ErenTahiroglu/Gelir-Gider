import type { DatabaseTransaction } from "../db/client";
import { ensureDeterministicLedgerAccountInTransaction } from "../ledger/accounts";

export const LONG_TERM_EXTERNAL_COST_ACCOUNT_CODE =
	"SYS_LONG_TERM_EXTERNAL_COST";

/**
 * Ensures the single deterministic per-user SYS_LONG_TERM_EXTERNAL_COST
 * ledger account exists (account_type = ASSET, normal_balance = DEBIT,
 * currency = user's authoritative currency, unarchived). This account
 * tracks external long-term investment contributions at transferred cost
 * basis only -- it is NOT portfolio market value, a security holding, or
 * return tracking. Uses the existing safe deterministic account ensure
 * primitive (INSERT ... ON CONFLICT DO NOTHING -> re-read -> exact contract
 * validation) -- never a raw 23505 recovery, never a suffixed duplicate
 * account.
 */
export async function ensureLongTermExternalCostAccountInTransaction(
	tx: DatabaseTransaction,
	userId: string,
): Promise<string> {
	const account = await ensureDeterministicLedgerAccountInTransaction({
		tx,
		userId,
		code: LONG_TERM_EXTERNAL_COST_ACCOUNT_CODE,
		name: "Long-Term Investment External Cost",
		accountType: "ASSET",
	});
	return account.id;
}

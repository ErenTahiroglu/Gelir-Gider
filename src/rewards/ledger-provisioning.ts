import type { DatabaseTransaction } from "../db/client";
import { ensureDeterministicLedgerAccountInTransaction } from "../ledger/accounts";

export const REWARD_BENEFIT_ACCOUNT_CODE = "SYS_REWARD_BENEFIT";

/**
 * Ensures the single deterministic per-user REWARD_BENEFIT ledger account
 * exists (account_type = INCOME, normal_balance = CREDIT, currency = user's
 * authoritative currency, unarchived). Uses the existing safe deterministic
 * account ensure primitive (INSERT ... ON CONFLICT DO NOTHING -> re-read ->
 * exact contract validation) -- never a raw 23505 recovery, never a
 * suffixed duplicate account. There is only one reward system account role
 * in V1, so no separate role-mapping table is needed (unlike the
 * multi-role credit-card system accounts).
 */
export async function ensureRewardBenefitAccountInTransaction(
	tx: DatabaseTransaction,
	userId: string,
): Promise<string> {
	const account = await ensureDeterministicLedgerAccountInTransaction({
		tx,
		userId,
		code: REWARD_BENEFIT_ACCOUNT_CODE,
		name: "Reward Benefit",
		accountType: "INCOME",
	});
	return account.id;
}

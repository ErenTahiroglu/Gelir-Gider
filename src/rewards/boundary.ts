import type { Database, DatabaseTransaction } from "../db/client";
import { LedgerError } from "../ledger/errors";
import { CanonicalTransactionError } from "../transactions/errors";
import { RewardError } from "./errors";

/**
 * Extracts and traverses the complete error cause chain into a lowercase
 * string to reliably inspect lower-layer and database engine errors.
 */
export function extractErrorCauseChain(err: unknown): string {
	const messages: string[] = [];
	let current: unknown = err;
	let depth = 0;
	const visited = new Set<unknown>();

	while (current && depth < 10 && !visited.has(current)) {
		visited.add(current);
		depth++;

		if (typeof current === "string") {
			messages.push(current);
		} else if (typeof current === "object" && current !== null) {
			const obj = current as Record<string, unknown>;
			if (typeof obj.message === "string") messages.push(obj.message);
			if (typeof obj.detail === "string") messages.push(obj.detail);
			if (typeof obj.hint === "string") messages.push(obj.hint);
			if (typeof obj.where === "string") messages.push(obj.where);
			if (typeof obj.constraint === "string") messages.push(obj.constraint);
			if (typeof obj.constraint_name === "string")
				messages.push(obj.constraint_name);
			if (typeof obj.routine === "string") messages.push(obj.routine);
			current = (current as { cause?: unknown }).cause;
		} else {
			break;
		}
	}

	return messages.join(" | ").toLowerCase();
}

/**
 * Checks whether an error represents a specific database constraint or
 * trigger error.
 */
export function matchesDbConstraint(
	err: unknown,
	constraintName: string,
	fragment?: string,
): boolean {
	const chain = extractErrorCauseChain(err);
	const lowerConstraint = constraintName.toLowerCase();
	if (chain.includes(lowerConstraint)) return true;
	if (fragment && chain.includes(fragment.toLowerCase())) return true;
	return false;
}

/**
 * Detects whether an error originated from Drizzle, pg-core, or PostgreSQL
 * driver layer.
 */
export function isDatabaseBoundaryError(err: unknown): boolean {
	let current: unknown = err;
	let depth = 0;
	const visited = new Set<unknown>();

	while (current && depth < 10 && !visited.has(current)) {
		visited.add(current);
		depth++;

		if (typeof current === "object" && current !== null) {
			const obj = current as Record<string, unknown>;

			if (
				typeof obj.name === "string" &&
				(obj.name === "DrizzleQueryError" ||
					obj.name === "DrizzleError" ||
					obj.name === "TransactionRollbackError")
			) {
				return true;
			}
			if ("query" in obj && typeof obj.query === "string") return true;

			if (typeof obj.code === "string") {
				if (/^[0-9A-Z]{5}$/.test(obj.code)) return true;
				if (
					obj.code.startsWith("PG_") ||
					obj.code === "ECONNRESET" ||
					obj.code === "ETIMEDOUT" ||
					obj.code === "EPIPE" ||
					obj.code === "ECONNREFUSED"
				) {
					return true;
				}
			}

			if (
				"constraint" in obj ||
				"constraint_name" in obj ||
				"severity" in obj ||
				"schema" in obj ||
				"table" in obj ||
				"column" in obj ||
				"routine" in obj ||
				"internalQuery" in obj ||
				"internalPosition" in obj
			) {
				return true;
			}

			if (typeof obj.message === "string") {
				const msg = obj.message;
				if (
					msg.includes("branching forbidden") ||
					msg.includes("trg_fn_guard_") ||
					msg.includes("trg_guard_") ||
					msg.includes("violates ") ||
					msg.includes("duplicate key ") ||
					msg.includes("deadlock detected")
				) {
					return true;
				}
			}

			current = (current as { cause?: unknown }).cause;
		} else {
			break;
		}
	}

	return false;
}

/**
 * Maps Canonical Transaction domain errors into sanitized RewardError
 * instances.
 */
export function mapCanonicalError(
	err: CanonicalTransactionError,
	_context?: string,
): never {
	switch (err.code) {
		case "TRANSACTION_IDEMPOTENCY_CONFLICT":
			throw new RewardError(
				"REWARD_IDEMPOTENCY_CONFLICT",
				"Reward transaction idempotency conflict",
			);
		case "TRANSACTION_REVISION_CONFLICT":
			throw new RewardError(
				"REWARD_EVENT_REVISION_CONFLICT",
				"Reward transaction revision conflict",
			);
		case "TRANSACTION_ALREADY_VOIDED":
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Reward transaction is already voided",
			);
		case "TRANSACTION_LEDGER_EFFECT_CONFLICT":
		case "TRANSACTION_LEDGER_EFFECT_INVALID":
		case "TRANSACTION_LEDGER_INCOMPLETE_STATE":
		case "TRANSACTION_PAYLOAD_INVALID":
		case "TRANSACTION_SOURCE_CONFLICT":
		case "TRANSACTION_INVALID_STATE":
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Reward canonical transaction state conflict",
			);
		case "TRANSACTION_INVALID_INPUT":
		case "TRANSACTION_NOT_FOUND":
			throw new RewardError(
				"REWARD_INVALID_INPUT",
				"Reward transaction input invalid",
			);
		default:
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Reward canonical transaction failed",
			);
	}
}

/**
 * Maps Ledger domain errors into sanitized RewardError instances.
 */
export function mapLedgerError(err: LedgerError, _context?: string): never {
	switch (err.code) {
		case "LEDGER_ACCOUNT_NOT_FOUND":
		case "LEDGER_ACCOUNT_ARCHIVED":
		case "LEDGER_ACCOUNT_IN_USE":
		case "LEDGER_CURRENCY_MISMATCH":
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Reward ledger account is invalid or archived",
			);
		case "LEDGER_IDEMPOTENCY_CONFLICT":
			throw new RewardError(
				"REWARD_IDEMPOTENCY_CONFLICT",
				"Reward ledger journal idempotency conflict",
			);
		case "INVALID_MONEY":
		case "LEDGER_INVALID_ENTRY":
		case "LEDGER_USER_NOT_FOUND":
			throw new RewardError(
				"REWARD_INVALID_INPUT",
				"Reward ledger entry input is invalid",
			);
		default:
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Reward ledger state conflict",
			);
	}
}

/**
 * Maps recognized database errors, triggers, and constraint violations into
 * sanitized RewardError instances. No raw SQL/constraint/query/credential
 * data may escape.
 */
export function mapDbError(err: unknown, _context?: string): never {
	if (err instanceof RewardError) throw err;
	if (err instanceof CanonicalTransactionError) mapCanonicalError(err);
	if (err instanceof LedgerError) mapLedgerError(err);
	if (!isDatabaseBoundaryError(err)) {
		throw err;
	}

	const causeChain = extractErrorCauseChain(err);

	if (
		causeChain.includes("non-zero point balance") ||
		causeChain.includes("with non-zero point balance")
	) {
		throw new RewardError(
			"REWARD_ACCOUNT_CONFLICT",
			"Cannot archive reward account with non-zero point balance",
		);
	}
	if (
		causeChain.includes("point balance would become negative") ||
		causeChain.includes("negative point balance")
	) {
		throw new RewardError(
			"REWARD_INSUFFICIENT_POINTS",
			"Operation would result in a negative reward point balance",
		);
	}
	if (
		causeChain.includes("non-active reward account") ||
		causeChain.includes("cannot mutate reward event for non-active") ||
		causeChain.includes("cannot create revision on archived") ||
		causeChain.includes("archived reward account")
	) {
		throw new RewardError(
			"REWARD_ACCOUNT_NOT_ACTIVE",
			"Reward account is not active for this operation",
		);
	}
	if (matchesDbConstraint(err, "reward_accounts_user_code_idx")) {
		throw new RewardError(
			"REWARD_ACCOUNT_CONFLICT",
			"Reward account code conflict",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"reward_account_revisions_account_rev_idx",
			"trg_fn_guard_reward_account_revision_insert",
		)
	) {
		throw new RewardError(
			"REWARD_ACCOUNT_REVISION_CONFLICT",
			"Reward account revision conflict",
		);
	}
	if (
		matchesDbConstraint(err, "reward_account_revisions_user_idempotency_idx")
	) {
		throw new RewardError(
			"REWARD_IDEMPOTENCY_CONFLICT",
			"Reward account idempotency key conflict",
		);
	}
	if (matchesDbConstraint(err, "reward_events_account_opening_idx")) {
		throw new RewardError(
			"REWARD_EVENT_CONFLICT",
			"An opening balance event already exists for this reward account",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"reward_event_revisions_event_rev_idx",
			"trg_fn_guard_reward_event_revision_insert",
		)
	) {
		throw new RewardError(
			"REWARD_EVENT_REVISION_CONFLICT",
			"Reward event revision conflict",
		);
	}
	if (matchesDbConstraint(err, "reward_event_revisions_user_idempotency_idx")) {
		throw new RewardError(
			"REWARD_IDEMPOTENCY_CONFLICT",
			"Reward event idempotency key conflict",
		);
	}
	if (
		causeChain.includes("naked account anchor") ||
		causeChain.includes("naked event anchor") ||
		causeChain.includes("no linked reward_events anchor") ||
		causeChain.includes("no linked reward_event_revisions row")
	) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Reward domain anchor completeness violation",
		);
	}

	throw new RewardError(
		"REWARD_INVALID_STATE",
		"Reward state transition failed",
	);
}

/**
 * Executes a unit of work inside a managed database transaction with
 * centralized error boundary mapping.
 */
export async function runRewardsTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work);
	} catch (err: unknown) {
		if (err instanceof RewardError) throw err;
		if (err instanceof CanonicalTransactionError) mapCanonicalError(err);
		if (err instanceof LedgerError) mapLedgerError(err);
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}

/**
 * Executes a read-only unit of work under REPEATABLE READ isolation so a
 * result combining multiple statements (account latest revision, events,
 * derived point balance, estimated valuation, canonical purchase
 * information) is guaranteed to come from one coherent snapshot.
 */
export async function runRewardsReadTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work, { isolationLevel: "repeatable read" });
	} catch (err: unknown) {
		if (err instanceof RewardError) throw err;
		if (err instanceof CanonicalTransactionError) mapCanonicalError(err);
		if (err instanceof LedgerError) mapLedgerError(err);
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}

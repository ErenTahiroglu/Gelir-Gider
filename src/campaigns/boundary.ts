import { CreditCardError } from "../credit-cards/errors";
import type { Database, DatabaseTransaction } from "../db/client";
import { RewardError } from "../rewards/errors";
import { CampaignError } from "./errors";

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
 * Maps Credit Card domain errors into sanitized CampaignError instances.
 */
export function mapCreditCardError(err: CreditCardError): never {
	switch (err.code) {
		case "CREDIT_CARD_NOT_FOUND":
			throw new CampaignError(
				"CAMPAIGN_PURCHASE_NOT_FOUND",
				"Referenced credit card or purchase not found",
			);
		case "CREDIT_CARD_INVALID_INPUT":
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				"Credit card input invalid",
			);
		default:
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Credit card domain state conflict",
			);
	}
}

/**
 * Maps Reward domain errors into sanitized CampaignError instances.
 */
export function mapRewardError(err: RewardError): never {
	switch (err.code) {
		case "REWARD_ACCOUNT_NOT_FOUND":
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				"Reward account not found",
			);
		case "REWARD_ACCOUNT_NOT_ACTIVE":
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Reward account is not active",
			);
		case "REWARD_INVALID_INPUT":
			throw new CampaignError("CAMPAIGN_INVALID_INPUT", "Reward input invalid");
		case "REWARD_IDEMPOTENCY_CONFLICT":
			throw new CampaignError(
				"CAMPAIGN_IDEMPOTENCY_CONFLICT",
				"Reward idempotency conflict",
			);
		case "REWARD_INSUFFICIENT_POINTS":
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Insufficient reward points for this operation",
			);
		case "REWARD_EVENT_NOT_FOUND":
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				"Linked reward event not found",
			);
		case "REWARD_EVENT_NOT_ACTIVE":
		case "REWARD_EVENT_REVISION_CONFLICT":
			throw new CampaignError(
				"CAMPAIGN_REVISION_CONFLICT",
				"Reward event revision conflict",
			);
		default:
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Reward domain state conflict",
			);
	}
}

/**
 * Maps recognized database errors, triggers, and constraint violations into
 * sanitized CampaignError instances. No raw SQL/constraint/query/credential
 * data may escape.
 */
export function mapDbError(err: unknown): never {
	if (err instanceof CampaignError) throw err;
	if (err instanceof CreditCardError) mapCreditCardError(err);
	if (err instanceof RewardError) mapRewardError(err);
	if (!isDatabaseBoundaryError(err)) {
		throw err;
	}

	const causeChain = extractErrorCauseChain(err);

	if (
		causeChain.includes("branching forbidden") ||
		causeChain.includes("revision conflict") ||
		causeChain.includes("is not current latest revision")
	) {
		throw new CampaignError(
			"CAMPAIGN_REVISION_CONFLICT",
			"Campaign revision conflict",
		);
	}
	if (
		causeChain.includes("already has an active reward credit identity") ||
		causeChain.includes("cannot create revision on void credit")
	) {
		throw new CampaignError(
			"CAMPAIGN_REWARD_ALREADY_CREDITED",
			"Campaign period already has an active reward credit",
		);
	}
	if (
		causeChain.includes("naked family anchor") ||
		causeChain.includes("naked period anchor") ||
		causeChain.includes("naked override anchor") ||
		causeChain.includes("naked credit anchor") ||
		causeChain.includes("has zero linked cards at commit")
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_STATE",
			"Campaign domain anchor completeness violation",
		);
	}
	if (
		causeChain.includes("is not within campaign period") ||
		causeChain.includes("is not a purchase identity")
	) {
		throw new CampaignError(
			"CAMPAIGN_PURCHASE_NOT_FOUND",
			"Purchase is not eligible for override under this campaign scope",
		);
	}
	if (
		matchesDbConstraint(err, "campaign_period_revisions_user_idempotency_idx")
	) {
		throw new CampaignError(
			"CAMPAIGN_IDEMPOTENCY_CONFLICT",
			"Campaign period idempotency key conflict",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"campaign_purchase_override_revisions_user_idempotency_idx",
		)
	) {
		throw new CampaignError(
			"CAMPAIGN_IDEMPOTENCY_CONFLICT",
			"Campaign override idempotency key conflict",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"campaign_reward_credit_revisions_user_idempotency_idx",
		)
	) {
		throw new CampaignError(
			"CAMPAIGN_IDEMPOTENCY_CONFLICT",
			"Campaign reward credit idempotency key conflict",
		);
	}
	if (
		matchesDbConstraint(err, "campaign_families_user_provider_key_idx") ||
		matchesDbConstraint(err, "campaign_periods_family_period_key_idx")
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_STATE",
			"Campaign family/period identity conflict",
		);
	}

	throw new CampaignError(
		"CAMPAIGN_INVALID_STATE",
		"Campaign state transition failed",
	);
}

/**
 * Executes a unit of work inside a managed database transaction with
 * centralized error boundary mapping.
 */
export async function runCampaignsTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work);
	} catch (err: unknown) {
		if (err instanceof CampaignError) throw err;
		if (err instanceof CreditCardError) mapCreditCardError(err);
		if (err instanceof RewardError) mapRewardError(err);
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}

/**
 * Executes a read-only unit of work under REPEATABLE READ isolation so a
 * progress read model combining multiple statements is guaranteed to come
 * from one coherent snapshot.
 */
export async function runCampaignsReadTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work, { isolationLevel: "repeatable read" });
	} catch (err: unknown) {
		if (err instanceof CampaignError) throw err;
		if (err instanceof CreditCardError) mapCreditCardError(err);
		if (err instanceof RewardError) mapRewardError(err);
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}

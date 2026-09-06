import { and, desc, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import { merchantAliases } from "../db/schema/campaigns";
import { CampaignError } from "./errors";

/**
 * Deterministically normalizes a raw merchant string for alias matching:
 * trim, Unicode-safe casefold-equivalent lowercase, collapse repeated
 * whitespace, and strip a narrow well-defined set of punctuation (commas,
 * periods, asterisks, and other symbols banks commonly inject into POS
 * descriptors) -- never probabilistic/fuzzy matching. Two merchant strings
 * that differ only in case, spacing, or this punctuation set resolve to the
 * identical normalized alias key.
 */
export function normalizeMerchantAlias(raw: string): string {
	return raw
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[.,*#/\\_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Validates a raw merchant alias input string (non-empty after trim).
 */
export function validateMerchantAliasInput(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.length > 200) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be non-empty and at most 200 characters`,
		);
	}
	return trimmed;
}

/**
 * Resolves a raw purchase merchant string to a canonical merchant name via
 * the user's append-only merchant alias memory (latest row for the
 * normalized alias wins). Returns null when no mapping exists -- callers
 * must never guess a canonical identity via fuzzy matching.
 */
export async function resolveCanonicalMerchantNameInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	rawMerchant: string | null,
): Promise<string | null> {
	if (rawMerchant === null) return null;
	const normalized = normalizeMerchantAlias(rawMerchant);
	if (normalized === "") return null;

	const [latest] = await tx
		.select({ canonicalMerchantName: merchantAliases.canonicalMerchantName })
		.from(merchantAliases)
		.where(
			and(
				eq(merchantAliases.userId, userId),
				eq(merchantAliases.rawNormalizedAlias, normalized),
			),
		)
		.orderBy(desc(merchantAliases.createdAt))
		.limit(1);

	return latest?.canonicalMerchantName ?? null;
}

/**
 * Records a new merchant alias mapping (append-only correction memory). A
 * later row for the same normalized alias silently supersedes an earlier one
 * for resolution purposes (latest-wins), without ever deleting/mutating the
 * earlier row.
 */
export async function recordMerchantAliasInTransaction(
	tx: DatabaseTransaction,
	args: { userId: string; rawAlias: string; canonicalMerchantName: string },
): Promise<{ id: string }> {
	const normalized = normalizeMerchantAlias(args.rawAlias);
	if (normalized === "") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"rawAlias normalizes to an empty string",
		);
	}
	const canonical = args.canonicalMerchantName.trim();
	if (canonical === "") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"canonicalMerchantName cannot be empty",
		);
	}
	const [inserted] = await tx
		.insert(merchantAliases)
		.values({
			userId: args.userId,
			rawNormalizedAlias: normalized,
			canonicalMerchantName: canonical,
		})
		.returning({ id: merchantAliases.id });
	if (!inserted) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_STATE",
			"Failed to record merchant alias",
		);
	}
	return { id: inserted.id };
}

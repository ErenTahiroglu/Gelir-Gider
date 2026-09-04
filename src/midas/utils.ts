import { MidasError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates and canonicalizes an externally supplied UUID string to lowercase.
 * Throws MIDAS_INVALID_INPUT if value is not a valid UUID.
 */
export function normalizeCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", `${fieldName} cannot be empty`);
	}

	if (!UUID_PATTERN.test(trimmed)) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}

	return trimmed.toLowerCase();
}

/**
 * Recursively extracts and concatenates error messages and details across the cause chain.
 */
export function extractErrorCauseChain(err: unknown): string {
	if (!err) return "";
	const visited = new Set<unknown>();
	const parts: string[] = [];
	let current: unknown = err;

	while (current && !visited.has(current)) {
		visited.add(current);
		if (typeof current === "string") {
			parts.push(current);
			break;
		}
		if (typeof current === "object") {
			const obj = current as Record<string, unknown>;
			if (typeof obj.message === "string") parts.push(obj.message);
			if (typeof obj.detail === "string") parts.push(obj.detail);
			if (typeof obj.where === "string") parts.push(obj.where);
			if (typeof obj.routine === "string") parts.push(obj.routine);
			if (typeof obj.constraint === "string") parts.push(obj.constraint);
			current = obj.cause;
		} else {
			break;
		}
	}

	return parts.join(" | ");
}

/**
 * Narrowly checks if a database error during Midas account insertion was caused
 * by the linked ledger account failing validation in the DB trigger (e.g. negative physical balance,
 * non-ASSET, archived, currency mismatch, etc.).
 */
export function isMidasLedgerAccountInvalidDbError(err: unknown): boolean {
	const chain = extractErrorCauseChain(err);
	if (!chain) return false;

	return (
		chain.includes("Cannot link Midas account to ledger account") ||
		chain.includes("with negative physical balance") ||
		chain.includes("Midas linked ledger account must have") ||
		chain.includes("Midas linked ledger account currency") ||
		chain.includes("Midas linked ledger account cannot be archived") ||
		chain.includes("trg_fn_guard_midas_accounts_insert")
	);
}

/**
 * Narrowly checks if a database error during ledger account update/archive was caused
 * by the DB archive guard trigger because the account is linked to a Midas account.
 */
export function isLedgerAccountInUseDbError(err: unknown): boolean {
	const chain = extractErrorCauseChain(err);
	if (!chain) return false;

	return (
		chain.includes("because it is linked to Midas liquidity account") ||
		chain.includes("trg_fn_guard_ledger_accounts_archive") ||
		chain.includes("trg_guard_ledger_accounts_archive")
	);
}

/**
 * Narrowly checks if a database error during allocation transfer insertion was caused
 * by a short-term goal bucket trigger because the goal is not in ACTIVE status.
 */
export function isMidasBucketInactiveDbError(err: unknown): boolean {
	const chain = extractErrorCauseChain(err);
	if (!chain) return false;

	return (
		chain.includes("because goal is in") &&
		chain.includes("status (must be ACTIVE)")
	);
}

/**
 * Narrowly checks if a database error during allocation transfer insertion was caused
 * by a short-term goal bucket trigger because the transfer would exceed max_budget.
 */
export function isMidasBucketCapExceededDbError(err: unknown): boolean {
	const chain = extractErrorCauseChain(err);
	if (!chain) return false;

	return chain.includes("exceeds short-term goal max budget");
}

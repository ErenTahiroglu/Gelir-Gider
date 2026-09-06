import type { Database, DatabaseTransaction } from "../db/client";
import { NotificationError } from "./errors";

/**
 * Extracts and traverses the complete error cause chain into a lowercase
 * string to reliably inspect lower-layer and database engine errors. Mirrors
 * `month-close/boundary.ts::extractErrorCauseChain`.
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
 * Maps recognized database errors, triggers, and constraint violations into
 * sanitized NotificationError instances. No raw SQL/constraint/query text,
 * push endpoint, p256dh, auth, or VAPID private key may ever escape.
 */
export function mapDbError(err: unknown): never {
	if (err instanceof NotificationError) throw err;
	if (!isDatabaseBoundaryError(err)) {
		throw err;
	}

	if (
		matchesDbConstraint(err, "push_subscriptions_user_endpoint_hash_idx") ||
		matchesDbConstraint(err, "push_sub_revisions_user_idempotency_idx") ||
		matchesDbConstraint(err, "notification_events_user_type_subject_idx") ||
		matchesDbConstraint(err, "notification_deliveries_event_sub_idx") ||
		matchesDbConstraint(err, "notification_delivery_attempts_delivery_no_idx")
	) {
		throw new NotificationError(
			"NOTIFICATION_IDEMPOTENCY_CONFLICT",
			"A conflicting notification record already exists for this identity",
		);
	}

	throw new NotificationError(
		"NOTIFICATION_INVALID_STATE",
		"Notification domain state transition failed",
	);
}

/**
 * Executes a unit of work inside a managed database transaction with
 * centralized error boundary mapping.
 */
export async function runNotificationTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work);
	} catch (err: unknown) {
		if (err instanceof NotificationError) throw err;
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}

/**
 * Executes a read-only unit of work under REPEATABLE READ isolation so a
 * result combining multiple statements comes from one coherent snapshot.
 */
export async function runNotificationReadTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work, { isolationLevel: "repeatable read" });
	} catch (err: unknown) {
		if (err instanceof NotificationError) throw err;
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}

import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	authEnrollmentGrants,
	authRecoveryCodes,
	users,
} from "../db/schema/auth";

export const RECOVERY_CODE_BYTES = 24; // 192 bits of entropy
export const RECOVERY_CODE_CANONICAL_LENGTH = 32; // 24 bytes unpadded base64url is 32 chars
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/**
 * Generates an offline high-entropy recovery code.
 * 24 random bytes (192 bits), unpadded base64url (32 characters).
 * Returns canonical code (32 chars) and formatted display code (XXXX.XXXX.XXXX.XXXX.XXXX.XXXX.XXXX.XXXX).
 */
export function generateRecoveryCode(): {
	canonical: string;
	display: string;
} {
	const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	const base64 = btoa(binary);
	const canonical = base64
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	// Group into 8 groups of 4 characters separated by dots
	const parts: string[] = [];
	for (let i = 0; i < canonical.length; i += 4) {
		parts.push(canonical.slice(i, i + 4));
	}
	const display = parts.join(".");

	return {
		canonical,
		display,
	};
}

/**
 * Normalizes user-input recovery code:
 * - trims leading/trailing whitespace
 * - removes '.' dot separators
 * Validates that result is exactly 32 base64url characters without changing case.
 */
export function normalizeRecoveryCode(rawInput: string): string {
	if (!rawInput || rawInput.trim() === "") {
		throw new Error("Recovery code cannot be empty");
	}

	const cleaned = rawInput.trim().replace(/\./g, "");
	if (!BASE64URL_PATTERN.test(cleaned)) {
		throw new Error(
			"Invalid recovery code format: expected 32 base64url characters",
		);
	}

	return cleaned;
}

/**
 * Computes the SHA-256 hash of a canonical recovery code.
 * Returns 64-character lowercase hexadecimal string.
 */
export async function hashRecoveryCode(canonicalCode: string): Promise<string> {
	if (!canonicalCode || canonicalCode.trim() === "") {
		throw new Error("Recovery code cannot be empty");
	}

	const encoded = new TextEncoder().encode(canonicalCode);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(digest));

	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RotateRecoveryCodeParams {
	db: Database;
	userId: string;
}

/**
 * Rotates the recovery code for a user inside an atomic transaction.
 * User-level serialization:
 * 1. Locks the user row using FOR UPDATE
 * 2. Revokes all active recovery codes for the user
 * 3. Revokes all pending RECOVERY enrollment grants for the user (invalidating stale grants)
 * 4. Inserts the new recovery code hash
 * 5. Returns canonical & display codes to caller once
 */
export async function rotateRecoveryCode({
	db,
	userId,
}: RotateRecoveryCodeParams) {
	const now = new Date();
	const generated = generateRecoveryCode();
	const codeHash = await hashRecoveryCode(generated.canonical);

	return await db.transaction(async (tx) => {
		// 1. Lock user row FOR UPDATE
		const [user] = await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, userId))
			.for("update")
			.limit(1);

		if (!user) {
			throw new Error("User not found during recovery code rotation");
		}

		// 2. Revoke existing active recovery codes for user
		await tx
			.update(authRecoveryCodes)
			.set({ revokedAt: now })
			.where(
				and(
					eq(authRecoveryCodes.userId, userId),
					isNull(authRecoveryCodes.consumedAt),
					isNull(authRecoveryCodes.revokedAt),
				),
			);

		// 3. Revoke all pending RECOVERY enrollment grants for this user
		await tx
			.update(authEnrollmentGrants)
			.set({ revokedAt: now })
			.where(
				and(
					eq(authEnrollmentGrants.userId, userId),
					eq(authEnrollmentGrants.purpose, "RECOVERY"),
					isNull(authEnrollmentGrants.consumedAt),
					isNull(authEnrollmentGrants.revokedAt),
				),
			);

		// 4. Insert new code hash
		const [created] = await tx
			.insert(authRecoveryCodes)
			.values({
				userId,
				codeHash,
				createdAt: now,
			})
			.returning();

		if (!created) {
			throw new Error("Failed to create recovery code row");
		}

		return {
			canonical: generated.canonical,
			display: generated.display,
			recoveryCodeId: created.id,
		};
	});
}

export interface FindActiveRecoveryCodeByHashParams {
	db: Database;
	userId: string;
	codeHash: string;
}

/**
 * Looks up an active recovery code for a user by hash.
 */
export async function findActiveRecoveryCodeByHash({
	db,
	userId,
	codeHash,
}: FindActiveRecoveryCodeByHashParams) {
	const [active] = await db
		.select()
		.from(authRecoveryCodes)
		.where(
			and(
				eq(authRecoveryCodes.userId, userId),
				eq(authRecoveryCodes.codeHash, codeHash),
				isNull(authRecoveryCodes.consumedAt),
				isNull(authRecoveryCodes.revokedAt),
			),
		)
		.limit(1);

	return active ?? null;
}

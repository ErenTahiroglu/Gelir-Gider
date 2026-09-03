import type { Database } from "../db/client";
import { users } from "../db/schema/auth";
import { issueEnrollmentGrant } from "./enrollment-grants";
import {
	findActiveRecoveryCodeByHash,
	hashRecoveryCode,
	normalizeRecoveryCode,
} from "./recovery";

export type AuthErrorCode =
	| "BOOTSTRAP_INVALID"
	| "BOOTSTRAP_ALREADY_COMPLETED"
	| "INVALID_DISPLAY_NAME"
	| "RECOVERY_CODE_INVALID"
	| "RECOVERY_NOT_INITIALIZED"
	| "ENROLLMENT_GRANT_INVALID";

export class AuthError extends Error {
	constructor(
		public readonly code: AuthErrorCode,
		message: string,
	) {
		super(message);
		this.name = "AuthError";
	}
}

/**
 * Constant-time comparison between two 64-character lowercase hexadecimal hashes.
 * Converts each hex string into a 32-byte Uint8Array and XORs all bytes.
 * Returns false immediately if lengths or formats differ.
 */
export function timingSafeHashEqual(a: string, b: string): boolean {
	if (typeof a !== "string" || typeof b !== "string") {
		return false;
	}
	if (a.length !== 64 || b.length !== 64) {
		return false;
	}

	let result = 0;
	for (let i = 0; i < 64; i += 2) {
		const byteA = Number.parseInt(a.slice(i, i + 2), 16);
		const byteB = Number.parseInt(b.slice(i, i + 2), 16);
		if (Number.isNaN(byteA) || Number.isNaN(byteB)) {
			return false;
		}
		result |= byteA ^ byteB;
	}

	return result === 0;
}

/**
 * Computes SHA-256 hash of a raw bootstrap token string.
 * Returns 64 lowercase hexadecimal characters.
 */
export async function hashBootstrapToken(token: string): Promise<string> {
	if (!token || token.trim() === "") {
		throw new Error("Bootstrap token cannot be empty");
	}

	const encoded = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(digest));

	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AuthorizeBootstrapParams {
	db: Database;
	bootstrapToken: string;
	expectedBootstrapTokenHash: string;
	displayName: string;
}

/**
 * Authorizes bootstrap of an uninitialized instance.
 * Validates bootstrap token against expected hash using constant-time comparison.
 * Ensures display name is 1-100 characters.
 * Looks up or creates singleton user with auth_initialized_at = NULL.
 * Rejects with BOOTSTRAP_ALREADY_COMPLETED if instance is already initialized.
 * Issues BOOTSTRAP enrollment grant.
 * NOTE: Does NOT set auth_initialized_at in this phase!
 */
export async function authorizeBootstrapAndIssueGrant({
	db,
	bootstrapToken,
	expectedBootstrapTokenHash,
	displayName,
}: AuthorizeBootstrapParams) {
	// A. Validate bootstrap token hash
	const inputHash = await hashBootstrapToken(bootstrapToken);
	if (!timingSafeHashEqual(inputHash, expectedBootstrapTokenHash)) {
		throw new AuthError(
			"BOOTSTRAP_INVALID",
			"Invalid bootstrap credentials provided",
		);
	}

	// B. Validate display name
	const trimmedDisplayName = displayName?.trim();
	if (!trimmedDisplayName || trimmedDisplayName.length > 100) {
		throw new AuthError(
			"INVALID_DISPLAY_NAME",
			"Display name must be between 1 and 100 characters",
		);
	}

	// C. Find or create singleton user
	let [singletonUser] = await db.select().from(users).limit(1);

	if (!singletonUser) {
		// Attempt insert singleton user
		const [createdUser] = await db
			.insert(users)
			.values({
				displayName: trimmedDisplayName,
			})
			.onConflictDoNothing()
			.returning();

		if (createdUser) {
			singletonUser = createdUser;
		} else {
			// In case of concurrent insert, select the winner
			const [existing] = await db.select().from(users).limit(1);
			if (!existing) {
				throw new Error("Failed to resolve singleton user during bootstrap");
			}
			singletonUser = existing;
		}
	}

	// D. Check initialization state
	if (singletonUser.authInitializedAt !== null) {
		throw new AuthError(
			"BOOTSTRAP_ALREADY_COMPLETED",
			"Instance has already been initialized with a primary credential",
		);
	}

	// E. Issue BOOTSTRAP enrollment grant
	const grantResult = await issueEnrollmentGrant({
		db,
		userId: singletonUser.id,
		purpose: "BOOTSTRAP",
	});

	return {
		user: {
			id: singletonUser.id,
			displayName: singletonUser.displayName,
		},
		enrollmentGrant: grantResult.token,
	};
}

export interface AuthorizeRecoveryParams {
	db: Database;
	recoveryCode: string;
}

/**
 * Authorizes offline recovery of an initialized instance.
 * Checks that instance is initialized (auth_initialized_at is not null).
 * Normalizes and hashes recovery code.
 * Matches against active recovery code row.
 * Issues RECOVERY enrollment grant linked to recovery_code_id.
 * CRITICAL: Non-destructive! Does NOT consume recovery code, does NOT revoke sessions/credentials.
 */
export async function authorizeRecoveryAndIssueGrant({
	db,
	recoveryCode,
}: AuthorizeRecoveryParams) {
	// 1. Get singleton user
	const [singletonUser] = await db.select().from(users).limit(1);
	if (!singletonUser || singletonUser.authInitializedAt === null) {
		throw new AuthError(
			"RECOVERY_NOT_INITIALIZED",
			"Recovery cannot be performed on an uninitialized instance",
		);
	}

	// 2. Normalize and hash recovery code
	let canonicalCode: string;
	try {
		canonicalCode = normalizeRecoveryCode(recoveryCode);
	} catch {
		throw new AuthError(
			"RECOVERY_CODE_INVALID",
			"Invalid recovery code format",
		);
	}

	const codeHash = await hashRecoveryCode(canonicalCode);

	// 3. Match against active recovery code
	const activeCode = await findActiveRecoveryCodeByHash({
		db,
		userId: singletonUser.id,
		codeHash,
	});

	if (!activeCode) {
		throw new AuthError("RECOVERY_CODE_INVALID", "Invalid recovery code");
	}

	// 4. Issue RECOVERY enrollment grant (with transaction safety & source revalidation)
	try {
		const grantResult = await issueEnrollmentGrant({
			db,
			userId: singletonUser.id,
			purpose: "RECOVERY",
			recoveryCodeId: activeCode.id,
		});

		return {
			user: {
				id: singletonUser.id,
				displayName: singletonUser.displayName,
			},
			enrollmentGrant: grantResult.token,
		};
	} catch (err: unknown) {
		if (err instanceof Error && err.message === "RECOVERY_SOURCE_INVALID") {
			throw new AuthError("RECOVERY_CODE_INVALID", "Invalid recovery code");
		}
		throw err;
	}
}

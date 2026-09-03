import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	RegistrationResponseJSON,
	WebAuthnCredential,
} from "@simplewebauthn/server";
import {
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { WebAuthnConfig } from "../config/env";
import type { Database } from "../db/client";
import {
	authEnrollmentGrants,
	authRecoveryCodes,
	sessions,
	users,
	webauthnChallenges,
	webauthnCredentials,
} from "../db/schema/auth";
import {
	consumeActiveChallenge,
	consumeActiveRegistrationChallenge,
	WEBAUTHN_CHALLENGE_TTL_SECONDS,
} from "./challenges";
import {
	findActiveCredential,
	updateCredentialAfterAuthentication,
} from "./credentials";
import { hashEnrollmentGrantToken } from "./enrollment-grants";
import { generateRecoveryCode, hashRecoveryCode } from "./recovery";

export type WebAuthnErrorCode =
	| "INVALID_DEVICE_NAME"
	| "ENROLLMENT_GRANT_INVALID"
	| "ENROLLMENT_GRANT_EXPIRED"
	| "BOOTSTRAP_ALREADY_COMPLETED"
	| "RECOVERY_NOT_INITIALIZED"
	| "RECOVERY_SOURCE_INVALID"
	| "WEBAUTHN_CHALLENGE_INVALID"
	| "WEBAUTHN_REGISTRATION_FAILED"
	| "WEBAUTHN_AUTHENTICATION_FAILED"
	| "WEBAUTHN_CREDENTIAL_NOT_FOUND"
	| "WEBAUTHN_CREDENTIAL_STATE_CHANGED"
	| "CREDENTIAL_ALREADY_REGISTERED";

export class WebAuthnServiceError extends Error {
	constructor(
		public readonly code: WebAuthnErrorCode,
		message: string,
	) {
		super(message);
		this.name = "WebAuthnServiceError";
	}
}

interface BuildRegistrationOptionsInternalParams {
	config: WebAuthnConfig;
	user: {
		id: string;
		displayName: string;
	};
	existingCredentials?: {
		credentialId: string;
		transports?: AuthenticatorTransportFuture[] | null | undefined;
		revokedAt: Date | null;
	}[];
}

/**
 * Module-private helper to build WebAuthn registration options.
 * Not exported outside this file.
 */
async function buildRegistrationOptionsInternal({
	config,
	user,
	existingCredentials = [],
}: BuildRegistrationOptionsInternalParams) {
	const activeCredentials = existingCredentials.filter(
		(c) => c.revokedAt === null,
	);

	return generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpID,
		userName: user.displayName,
		userID: Uint8Array.from(new TextEncoder().encode(user.id)),
		authenticatorSelection: {
			residentKey: "preferred",
			userVerification: "required",
		},
		attestationType: "none",
		excludeCredentials: activeCredentials.map((cred) => {
			const desc: { id: string; transports?: AuthenticatorTransportFuture[] } =
				{
					id: cred.credentialId,
				};
			if (cred.transports && cred.transports.length > 0) {
				desc.transports = cred.transports;
			}
			return desc;
		}),
	});
}

export interface BeginAuthorizedPasskeyEnrollmentParams {
	db: Database;
	config: WebAuthnConfig;
	enrollmentGrantToken: string;
}

/**
 * Begins authorized WebAuthn passkey enrollment.
 * 1. Hashes raw enrollment grant token.
 * 2. Pre-lock lookup solely for routing hint (grant.id and grant.user_id).
 *    Never trusts pre-lock grant security state!
 * 3. Inside transaction:
 *    a. Locks user row FOR UPDATE.
 *    b. Fresh post-lock re-read of active grant row FOR UPDATE with active predicates:
 *       id = preLookup.id, user_id = locked user.id, token_hash = tokenHash,
 *       consumed_at IS NULL, revoked_at IS NULL, expires_at > now.
 *    c. Purpose-specific validation on the fresh post-lock grant row:
 *       - BOOTSTRAP: users.auth_initialized_at IS NULL
 *       - RECOVERY: users.auth_initialized_at IS NOT NULL AND linked recovery code is unconsumed & unrevoked.
 *    d. Fetches active credentials to exclude them.
 *    e. Generates registration options.
 *    f. Conditional atomic consume on enrollment grant with RETURNING checking exactly 1 row updated.
 *    g. Inserts REGISTRATION challenge linked to enrollment_grant_id.
 * 4. Returns options. On any failure, transaction rolls back cleanly.
 */
export async function beginAuthorizedPasskeyEnrollment({
	db,
	config,
	enrollmentGrantToken,
}: BeginAuthorizedPasskeyEnrollmentParams) {
	if (!enrollmentGrantToken || enrollmentGrantToken.trim() === "") {
		throw new WebAuthnServiceError(
			"ENROLLMENT_GRANT_INVALID",
			"Enrollment grant token cannot be empty",
		);
	}

	const tokenHash = await hashEnrollmentGrantToken(enrollmentGrantToken);
	const now = new Date();

	// Step 2: Pre-lock lookup strictly for routing hint (id and userId only)
	const [routingHint] = await db
		.select({
			id: authEnrollmentGrants.id,
			userId: authEnrollmentGrants.userId,
		})
		.from(authEnrollmentGrants)
		.where(eq(authEnrollmentGrants.tokenHash, tokenHash))
		.limit(1);

	if (!routingHint) {
		throw new WebAuthnServiceError(
			"ENROLLMENT_GRANT_INVALID",
			"Invalid enrollment grant token",
		);
	}

	return await db.transaction(async (tx) => {
		// Step 3a: Lock user row FOR UPDATE
		const [user] = await tx
			.select()
			.from(users)
			.where(eq(users.id, routingHint.userId))
			.for("update")
			.limit(1);

		if (!user) {
			throw new WebAuthnServiceError(
				"ENROLLMENT_GRANT_INVALID",
				"User associated with enrollment grant not found",
			);
		}

		// Step 3b: Fresh post-lock re-read of the grant FOR UPDATE
		// Check both active query and check expiry separately to distinguish error code if expired
		const [freshGrant] = await tx
			.select()
			.from(authEnrollmentGrants)
			.where(
				and(
					eq(authEnrollmentGrants.id, routingHint.id),
					eq(authEnrollmentGrants.userId, user.id),
					eq(authEnrollmentGrants.tokenHash, tokenHash),
					isNull(authEnrollmentGrants.consumedAt),
					isNull(authEnrollmentGrants.revokedAt),
				),
			)
			.for("update")
			.limit(1);

		if (!freshGrant) {
			throw new WebAuthnServiceError(
				"ENROLLMENT_GRANT_INVALID",
				"Enrollment grant has already been used, revoked, or does not exist",
			);
		}

		if (freshGrant.expiresAt <= now) {
			throw new WebAuthnServiceError(
				"ENROLLMENT_GRANT_EXPIRED",
				"Enrollment grant has expired",
			);
		}

		// Step 3c: Purpose-specific checks from fresh post-lock grant
		if (freshGrant.purpose === "BOOTSTRAP") {
			if (user.authInitializedAt !== null) {
				throw new WebAuthnServiceError(
					"BOOTSTRAP_ALREADY_COMPLETED",
					"Instance has already been initialized",
				);
			}
		} else if (freshGrant.purpose === "RECOVERY") {
			if (user.authInitializedAt === null) {
				throw new WebAuthnServiceError(
					"RECOVERY_NOT_INITIALIZED",
					"Instance has not been initialized yet",
				);
			}

			if (!freshGrant.recoveryCodeId) {
				throw new WebAuthnServiceError(
					"RECOVERY_SOURCE_INVALID",
					"Recovery grant is not linked to a recovery code",
				);
			}

			// Validate linked recovery code inside transaction
			const [recoveryCode] = await tx
				.select()
				.from(authRecoveryCodes)
				.where(
					and(
						eq(authRecoveryCodes.id, freshGrant.recoveryCodeId),
						eq(authRecoveryCodes.userId, user.id),
						isNull(authRecoveryCodes.consumedAt),
						isNull(authRecoveryCodes.revokedAt),
					),
				)
				.limit(1);

			if (!recoveryCode) {
				throw new WebAuthnServiceError(
					"RECOVERY_SOURCE_INVALID",
					"Linked recovery code is no longer active",
				);
			}
		} else {
			throw new WebAuthnServiceError(
				"ENROLLMENT_GRANT_INVALID",
				"Unknown enrollment grant purpose",
			);
		}

		// Step 3d: Fetch active credentials to exclude
		const existingCredentials = await tx
			.select({
				credentialId: webauthnCredentials.credentialId,
				transports: webauthnCredentials.transports,
				revokedAt: webauthnCredentials.revokedAt,
			})
			.from(webauthnCredentials)
			.where(
				and(
					eq(webauthnCredentials.userId, user.id),
					isNull(webauthnCredentials.revokedAt),
				),
			);

		// Step 3e: Generate registration options
		const options = await buildRegistrationOptionsInternal({
			config,
			user: {
				id: user.id,
				displayName: user.displayName,
			},
			existingCredentials: existingCredentials.map((c) => ({
				credentialId: c.credentialId,
				transports: c.transports as AuthenticatorTransportFuture[] | null,
				revokedAt: c.revokedAt,
			})),
		});

		// Step 3f: Conditional atomic consume with RETURNING
		const [consumedGrant] = await tx
			.update(authEnrollmentGrants)
			.set({ consumedAt: now })
			.where(
				and(
					eq(authEnrollmentGrants.id, freshGrant.id),
					eq(authEnrollmentGrants.userId, user.id),
					eq(authEnrollmentGrants.tokenHash, tokenHash),
					isNull(authEnrollmentGrants.consumedAt),
					isNull(authEnrollmentGrants.revokedAt),
					gt(authEnrollmentGrants.expiresAt, now),
				),
			)
			.returning({ id: authEnrollmentGrants.id });

		if (!consumedGrant) {
			throw new WebAuthnServiceError(
				"ENROLLMENT_GRANT_INVALID",
				"Failed to consume enrollment grant atomically",
			);
		}

		// Step 3g: Insert REGISTRATION challenge directly in transaction linked to enrollment_grant_id
		const challengeExpiresAt = new Date(
			Date.now() + WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
		);

		await tx.insert(webauthnChallenges).values({
			userId: user.id,
			purpose: "REGISTRATION",
			challenge: options.challenge,
			enrollmentGrantId: consumedGrant.id,
			expiresAt: challengeExpiresAt,
		});

		return options;
	});
}

export interface CompleteAuthorizedPasskeyEnrollmentParams {
	db: Database;
	config: WebAuthnConfig;
	response: RegistrationResponseJSON;
	deviceName: string;
}

export interface CompleteAuthorizedPasskeyEnrollmentResult {
	verified: true;
	purpose: "BOOTSTRAP" | "RECOVERY";
	user: {
		id: string;
		displayName: string;
	};
	credential: {
		id: string;
		credentialId: string;
		deviceName: string;
	};
	recoveryCode: {
		canonical: string;
		display: string;
	};
}

/**
 * Completes authorized WebAuthn passkey enrollment.
 * 1. Validates deviceName.
 * 2. Decodes challenge from clientDataJSON.
 * 3. Atomically consumes active challenge BEFORE verification (consume-on-attempt).
 * 4. Cryptographically verifies response with SimpleWebAuthn.
 * 5. In an atomic transaction:
 *    a. Locks user row FOR UPDATE.
 *    b. Re-reads the consumed challenge from DB to verify:
 *       id = consumedChallenge.id, user_id = locked user.id,
 *       purpose = 'REGISTRATION', enrollment_grant_id = consumedChallenge.enrollmentGrantId,
 *       consumed_at IS NOT NULL.
 *    c. Re-reads linked enrollment grant from DB:
 *       id = challenge.enrollment_grant_id, user_id = challenge.user_id,
 *       user_id = locked user.id, consumed_at IS NOT NULL, revoked_at IS NULL.
 *    d. Validates BOOTSTRAP / RECOVERY preconditions.
 *    e. BOOTSTRAP: sets auth_initialized_at = now(), inserts credential, inserts new recovery code hash, revokes other bootstrap grants.
 *    f. RECOVERY: revalidates source recovery code, inserts credential, revokes old credentials (excluding new credential), revokes sessions, consumes used recovery code, revokes pending recovery grants, inserts new recovery code hash.
 * 6. Returns credential info and single-view new recovery code.
 */
export async function completeAuthorizedPasskeyEnrollment({
	db,
	config,
	response,
	deviceName,
}: CompleteAuthorizedPasskeyEnrollmentParams): Promise<CompleteAuthorizedPasskeyEnrollmentResult> {
	// A. Validate deviceName
	const trimmedDeviceName = deviceName?.trim();
	if (!trimmedDeviceName || trimmedDeviceName.length === 0) {
		throw new WebAuthnServiceError(
			"INVALID_DEVICE_NAME",
			"Device name is required",
		);
	}
	if (trimmedDeviceName.length > 100) {
		throw new WebAuthnServiceError(
			"INVALID_DEVICE_NAME",
			"Device name must be 100 characters or fewer",
		);
	}

	// B. Decode clientDataJSON to extract challenge
	let clientChallenge: string;
	try {
		const clientData = decodeClientDataJSON(response.response.clientDataJSON);
		clientChallenge = clientData.challenge;
	} catch {
		throw new WebAuthnServiceError(
			"WEBAUTHN_CHALLENGE_INVALID",
			"Could not decode clientDataJSON",
		);
	}

	// C. Consume challenge BEFORE verification (consume-on-attempt)
	const consumedChallenge = await consumeActiveRegistrationChallenge({
		db,
		challenge: clientChallenge,
	});

	const enrollmentGrantId = consumedChallenge?.enrollmentGrantId;
	if (!consumedChallenge || !enrollmentGrantId) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_CHALLENGE_INVALID",
			"Registration challenge is invalid, expired, or already consumed",
		);
	}

	// D. SimpleWebAuthn cryptographic verification
	let verificationResult: Awaited<
		ReturnType<typeof verifyRegistrationResponse>
	>;
	try {
		verificationResult = await verifyRegistrationResponse({
			response,
			expectedChallenge: consumedChallenge.challenge,
			expectedOrigin: config.origin,
			expectedRPID: config.rpID,
			requireUserVerification: true,
		});
	} catch {
		throw new WebAuthnServiceError(
			"WEBAUTHN_REGISTRATION_FAILED",
			"Registration verification failed",
		);
	}

	if (!verificationResult.verified || !verificationResult.registrationInfo) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_REGISTRATION_FAILED",
			"Registration could not be verified",
		);
	}

	const { credential, credentialDeviceType, credentialBackedUp } =
		verificationResult.registrationInfo;

	// E. Finalization Transaction
	const newRecoveryCode = generateRecoveryCode();
	const newRecoveryCodeHash = await hashRecoveryCode(newRecoveryCode.canonical);
	const now = new Date();

	return await db.transaction(async (tx) => {
		// 1. Lock user row FOR UPDATE
		const [user] = await tx
			.select()
			.from(users)
			.where(eq(users.id, consumedChallenge.userId))
			.for("update")
			.limit(1);

		if (!user) {
			throw new WebAuthnServiceError(
				"WEBAUTHN_REGISTRATION_FAILED",
				"User associated with registration challenge not found",
			);
		}

		// 2. Re-read challenge from DB inside transaction
		const [freshChallenge] = await tx
			.select()
			.from(webauthnChallenges)
			.where(
				and(
					eq(webauthnChallenges.id, consumedChallenge.id),
					eq(webauthnChallenges.userId, user.id),
					eq(webauthnChallenges.purpose, "REGISTRATION"),
					eq(webauthnChallenges.enrollmentGrantId, enrollmentGrantId),
				),
			)
			.limit(1);

		if (!freshChallenge || freshChallenge.consumedAt === null) {
			throw new WebAuthnServiceError(
				"WEBAUTHN_CHALLENGE_INVALID",
				"Challenge verification in database failed or challenge was not properly consumed",
			);
		}

		const linkedGrantId = freshChallenge.enrollmentGrantId;
		if (!linkedGrantId) {
			throw new WebAuthnServiceError(
				"ENROLLMENT_GRANT_INVALID",
				"Challenge is missing linked enrollment grant",
			);
		}

		// 3. Re-read linked enrollment grant and verify challenge <-> grant <-> user binding
		const [grant] = await tx
			.select()
			.from(authEnrollmentGrants)
			.where(
				and(
					eq(authEnrollmentGrants.id, linkedGrantId),
					eq(authEnrollmentGrants.userId, freshChallenge.userId),
					eq(authEnrollmentGrants.userId, user.id),
				),
			)
			.limit(1);

		if (!grant || grant.revokedAt !== null || grant.consumedAt === null) {
			throw new WebAuthnServiceError(
				"ENROLLMENT_GRANT_INVALID",
				"Linked enrollment grant is invalid, not consumed, or revoked",
			);
		}

		let savedCredential: {
			id: string;
			credentialId: string;
			deviceName: string;
		};

		if (grant.purpose === "BOOTSTRAP") {
			// BOOTSTRAP Guard: Must not be already initialized
			if (user.authInitializedAt !== null) {
				throw new WebAuthnServiceError(
					"BOOTSTRAP_ALREADY_COMPLETED",
					"Instance has already been initialized",
				);
			}

			// Insert verified credential
			try {
				const [created] = await tx
					.insert(webauthnCredentials)
					.values({
						userId: user.id,
						credentialId: credential.id,
						publicKey: new Uint8Array(credential.publicKey),
						signCount: credential.counter,
						deviceName: trimmedDeviceName,
						deviceType: credentialDeviceType,
						transports: credential.transports ?? null,
						backedUp: credentialBackedUp,
						createdAt: now,
					})
					.returning();

				if (!created) {
					throw new Error("Failed to insert credential");
				}
				savedCredential = {
					id: created.id,
					credentialId: created.credentialId,
					deviceName: created.deviceName,
				};
			} catch (err: unknown) {
				const error = err as { code?: string; message?: string };
				if (
					error?.code === "23505" ||
					error?.message?.includes("unique") ||
					error?.message?.includes("duplicate key")
				) {
					throw new WebAuthnServiceError(
						"CREDENTIAL_ALREADY_REGISTERED",
						"This credential has already been registered",
					);
				}
				throw new WebAuthnServiceError(
					"WEBAUTHN_REGISTRATION_FAILED",
					"Failed to save credential",
				);
			}

			// Update user auth_initialized_at
			await tx
				.update(users)
				.set({ authInitializedAt: now })
				.where(eq(users.id, user.id));

			// Insert initial recovery code hash
			await tx.insert(authRecoveryCodes).values({
				userId: user.id,
				codeHash: newRecoveryCodeHash,
				createdAt: now,
			});

			// Revoke any other active bootstrap grants
			await tx
				.update(authEnrollmentGrants)
				.set({ revokedAt: now })
				.where(
					and(
						eq(authEnrollmentGrants.userId, user.id),
						eq(authEnrollmentGrants.purpose, "BOOTSTRAP"),
						isNull(authEnrollmentGrants.consumedAt),
						isNull(authEnrollmentGrants.revokedAt),
					),
				);
		} else if (grant.purpose === "RECOVERY") {
			// RECOVERY Guard: Re-validate source recovery code inside transaction
			if (!grant.recoveryCodeId) {
				throw new WebAuthnServiceError(
					"RECOVERY_SOURCE_INVALID",
					"Recovery grant missing linked recovery code",
				);
			}

			const [sourceRecoveryCode] = await tx
				.select()
				.from(authRecoveryCodes)
				.where(
					and(
						eq(authRecoveryCodes.id, grant.recoveryCodeId),
						eq(authRecoveryCodes.userId, user.id),
						isNull(authRecoveryCodes.consumedAt),
						isNull(authRecoveryCodes.revokedAt),
					),
				)
				.limit(1);

			if (!sourceRecoveryCode) {
				throw new WebAuthnServiceError(
					"RECOVERY_SOURCE_INVALID",
					"Source recovery code is no longer active",
				);
			}

			// Insert verified credential
			try {
				const [created] = await tx
					.insert(webauthnCredentials)
					.values({
						userId: user.id,
						credentialId: credential.id,
						publicKey: new Uint8Array(credential.publicKey),
						signCount: credential.counter,
						deviceName: trimmedDeviceName,
						deviceType: credentialDeviceType,
						transports: credential.transports ?? null,
						backedUp: credentialBackedUp,
						createdAt: now,
					})
					.returning();

				if (!created) {
					throw new Error("Failed to insert credential");
				}
				savedCredential = {
					id: created.id,
					credentialId: created.credentialId,
					deviceName: created.deviceName,
				};
			} catch (err: unknown) {
				const error = err as { code?: string; message?: string };
				if (
					error?.code === "23505" ||
					error?.message?.includes("unique") ||
					error?.message?.includes("duplicate key")
				) {
					throw new WebAuthnServiceError(
						"CREDENTIAL_ALREADY_REGISTERED",
						"This credential has already been registered",
					);
				}
				throw new WebAuthnServiceError(
					"WEBAUTHN_REGISTRATION_FAILED",
					"Failed to save credential",
				);
			}

			// Revoke ALL OTHER active credentials for this user and increment stateVersion
			await tx
				.update(webauthnCredentials)
				.set({
					revokedAt: now,
					stateVersion: sql`${webauthnCredentials.stateVersion} + 1`,
				})
				.where(
					and(
						eq(webauthnCredentials.userId, user.id),
						isNull(webauthnCredentials.revokedAt),
						sql`${webauthnCredentials.id} != ${savedCredential.id}`,
					),
				);

			// Revoke ALL active sessions for this user
			await tx
				.update(sessions)
				.set({ revokedAt: now })
				.where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));

			// Consume the source recovery code
			await tx
				.update(authRecoveryCodes)
				.set({ consumedAt: now })
				.where(eq(authRecoveryCodes.id, sourceRecoveryCode.id));

			// Revoke other pending RECOVERY enrollment grants
			await tx
				.update(authEnrollmentGrants)
				.set({ revokedAt: now })
				.where(
					and(
						eq(authEnrollmentGrants.userId, user.id),
						eq(authEnrollmentGrants.purpose, "RECOVERY"),
						isNull(authEnrollmentGrants.consumedAt),
						isNull(authEnrollmentGrants.revokedAt),
					),
				);

			// Insert new active recovery code
			await tx.insert(authRecoveryCodes).values({
				userId: user.id,
				codeHash: newRecoveryCodeHash,
				createdAt: now,
			});
		} else {
			throw new WebAuthnServiceError(
				"ENROLLMENT_GRANT_INVALID",
				"Unknown enrollment grant purpose",
			);
		}

		return {
			verified: true,
			purpose: grant.purpose as "BOOTSTRAP" | "RECOVERY",
			user: {
				id: user.id,
				displayName: user.displayName,
			},
			credential: savedCredential,
			recoveryCode: newRecoveryCode,
		};
	});
}

export interface VerifyAuthenticationForUserParams {
	db: Database;
	config: WebAuthnConfig;
	user: {
		id: string;
	};
	response: AuthenticationResponseJSON;
}

export async function verifyAuthenticationForUser({
	db,
	config,
	user,
	response,
}: VerifyAuthenticationForUserParams) {
	// 1. Decode clientDataJSON to extract challenge
	let clientChallenge: string;
	try {
		const clientData = decodeClientDataJSON(response.response.clientDataJSON);
		clientChallenge = clientData.challenge;
	} catch {
		throw new WebAuthnServiceError(
			"WEBAUTHN_CHALLENGE_INVALID",
			"Could not decode clientDataJSON",
		);
	}

	// 2. Consume-on-attempt: Atomically consume active challenge BEFORE verification
	const consumedChallenge = await consumeActiveChallenge({
		db,
		userId: user.id,
		purpose: "AUTHENTICATION",
		challenge: clientChallenge,
	});

	if (!consumedChallenge) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_CHALLENGE_INVALID",
			"Authentication challenge is invalid, expired, or already consumed",
		);
	}

	// 3. Find active credential (revoked credentials cannot be used)
	const credentialRecord = await findActiveCredential({
		db,
		userId: user.id,
		credentialId: response.id,
	});

	if (!credentialRecord) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_CREDENTIAL_NOT_FOUND",
			"Active credential not found for this user",
		);
	}

	// 4. SimpleWebAuthn verification
	const credentialParam: WebAuthnCredential = {
		id: credentialRecord.credentialId,
		publicKey: Uint8Array.from(credentialRecord.publicKey),
		counter: credentialRecord.signCount,
	};
	if (credentialRecord.transports && credentialRecord.transports.length > 0) {
		credentialParam.transports = credentialRecord.transports;
	}

	let verificationResult: Awaited<
		ReturnType<typeof verifyAuthenticationResponse>
	>;
	try {
		verificationResult = await verifyAuthenticationResponse({
			response,
			expectedChallenge: consumedChallenge.challenge,
			expectedOrigin: config.origin,
			expectedRPID: config.rpID,
			requireUserVerification: true,
			credential: credentialParam,
		});
	} catch {
		throw new WebAuthnServiceError(
			"WEBAUTHN_AUTHENTICATION_FAILED",
			"Authentication verification failed",
		);
	}

	if (!verificationResult.verified || !verificationResult.authenticationInfo) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_AUTHENTICATION_FAILED",
			"Authentication could not be verified",
		);
	}

	// 5. Update signature counter, state_version and lastUsedAt race-safely
	const updated = await updateCredentialAfterAuthentication({
		db,
		credentialDbId: credentialRecord.id,
		userId: user.id,
		previouslyReadCounter: credentialRecord.signCount,
		previousStateVersion: credentialRecord.stateVersion,
		newCounter: verificationResult.authenticationInfo.newCounter,
	});

	if (!updated) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_CREDENTIAL_STATE_CHANGED",
			"Credential state changed or revoked during authentication",
		);
	}

	return {
		verified: true as const,
		authenticationInfo: verificationResult.authenticationInfo,
		credential: updated,
	};
}

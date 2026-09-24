import {
	type AuthenticationResponseJSON,
	type AuthenticatorTransportFuture,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
	type WebAuthnCredential,
} from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import type { WebAuthnConfig } from "../config/env";
import type { Database } from "../db/client";
import { consumeActiveChallenge, createReauthChallenge } from "./challenges";
import {
	findActiveCredential,
	updateCredentialAfterAuthentication,
} from "./credentials";
import { WebAuthnServiceError } from "./verification";

export interface ReauthCredentialSummary {
	credentialId: string;
	transports?: AuthenticatorTransportFuture[] | null | undefined;
	revokedAt: Date | null;
}

export interface GenerateReauthOptionsParams {
	db: Database;
	config: WebAuthnConfig;
	user: {
		id: string;
	};
	existingCredentials?: ReauthCredentialSummary[] | undefined;
}

export async function generateReauthOptionsForUser({
	db,
	config,
	user,
	existingCredentials = [],
}: GenerateReauthOptionsParams) {
	const activeCredentials = existingCredentials.filter(
		(c) => c.revokedAt === null,
	);

	const options = await generateAuthenticationOptions({
		rpID: config.rpID,
		userVerification: "required",
		allowCredentials: activeCredentials.map((cred) => {
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

	// Fail-closed: REAUTH challenge MUST be persisted before returning options
	await createReauthChallenge({
		db,
		userId: user.id,
		challenge: options.challenge,
	});

	return options;
}

export interface VerifyReauthForUserParams {
	db: Database;
	config: WebAuthnConfig;
	user: {
		id: string;
	};
	response: AuthenticationResponseJSON;
}

export async function verifyReauthForUser({
	db,
	config,
	user,
	response,
}: VerifyReauthForUserParams) {
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

	// 2. Consume-on-attempt: Atomically consume active REAUTH challenge BEFORE verification
	const consumedChallenge = await consumeActiveChallenge({
		db,
		userId: user.id,
		purpose: "REAUTH",
		challenge: clientChallenge,
	});

	if (!consumedChallenge) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_CHALLENGE_INVALID",
			"Reauth challenge is invalid, expired, or already consumed",
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
			"Reauth verification failed",
		);
	}

	if (!verificationResult.verified || !verificationResult.authenticationInfo) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_AUTHENTICATION_FAILED",
			"Reauth could not be verified",
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
			"Credential state changed or revoked during reauthentication",
		);
	}

	// CRITICAL: Isolated REAUTH. Does NOT create new session or issue replacement session cookie.
	return {
		verified: true as const,
		credential: {
			id: updated.id,
			deviceName: updated.deviceName,
		},
	};
}

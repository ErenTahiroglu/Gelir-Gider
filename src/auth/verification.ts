import {
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type WebAuthnCredential,
} from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import type { WebAuthnConfig } from "../config/env";
import type { Database } from "../db/client";
import { consumeActiveChallenge } from "./challenges";
import {
	createCredential,
	findActiveCredential,
	updateCredentialAfterAuthentication,
} from "./credentials";

export type WebAuthnErrorCode =
	| "INVALID_DEVICE_NAME"
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

export interface VerifyRegistrationForUserParams {
	db: Database;
	config: WebAuthnConfig;
	user: {
		id: string;
	};
	response: RegistrationResponseJSON;
	deviceName: string;
}

export async function verifyRegistrationForUser({
	db,
	config,
	user,
	response,
	deviceName,
}: VerifyRegistrationForUserParams) {
	// Validate deviceName
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
		purpose: "REGISTRATION",
		challenge: clientChallenge,
	});

	if (!consumedChallenge) {
		throw new WebAuthnServiceError(
			"WEBAUTHN_CHALLENGE_INVALID",
			"Registration challenge is invalid, expired, or already consumed",
		);
	}

	// 3. SimpleWebAuthn verification
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

	// 4. Persist new credential
	try {
		const savedCredential = await createCredential({
			db,
			userId: user.id,
			credentialId: credential.id,
			publicKey: credential.publicKey,
			signCount: credential.counter,
			deviceName: trimmedDeviceName,
			deviceType: credentialDeviceType,
			transports: credential.transports ?? null,
			backedUp: credentialBackedUp,
		});

		return {
			verified: true as const,
			credential: savedCredential,
		};
	} catch (err: unknown) {
		// Detect duplicate credential uniqueness constraint violation
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

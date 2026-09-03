import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
} from "@simplewebauthn/server";
import type { WebAuthnConfig } from "../config/env";
import type { Database } from "../db/client";
import { createChallenge } from "./challenges";

export interface UserCredentialSummary {
	credentialId: string;
	revokedAt: Date | null;
}

export interface GenerateRegistrationOptionsParams {
	db?: Database | undefined;
	config: WebAuthnConfig;
	user: {
		id: string;
		displayName: string;
	};
	existingCredentials?: UserCredentialSummary[] | undefined;
}

export async function generateRegistrationOptionsForUser({
	db,
	config,
	user,
	existingCredentials = [],
}: GenerateRegistrationOptionsParams) {
	// Only active (non-revoked) credentials should be excluded to prevent re-registering the same authenticator
	const activeCredentials = existingCredentials.filter(
		(c) => c.revokedAt === null,
	);

	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpID,
		userName: user.displayName,
		userID: Uint8Array.from(new TextEncoder().encode(user.id)),
		authenticatorSelection: {
			residentKey: "preferred",
			userVerification: "required",
		},
		attestationType: "none",
		excludeCredentials: activeCredentials.map((cred) => ({
			id: cred.credentialId,
		})),
	});

	if (db) {
		await createChallenge({
			db,
			userId: user.id,
			purpose: "REGISTRATION",
			challenge: options.challenge,
		});
	}

	return options;
}

export interface GenerateAuthenticationOptionsParams {
	db?: Database | undefined;
	config: WebAuthnConfig;
	user: {
		id: string;
	};
	existingCredentials?: UserCredentialSummary[] | undefined;
}

export async function generateAuthenticationOptionsForUser({
	db,
	config,
	user,
	existingCredentials = [],
}: GenerateAuthenticationOptionsParams) {
	// Only active credentials are allowed for authentication
	const activeCredentials = existingCredentials.filter(
		(c) => c.revokedAt === null,
	);

	const options = await generateAuthenticationOptions({
		rpID: config.rpID,
		userVerification: "required",
		allowCredentials: activeCredentials.map((cred) => ({
			id: cred.credentialId,
		})),
	});

	if (db) {
		await createChallenge({
			db,
			userId: user.id,
			purpose: "AUTHENTICATION",
			challenge: options.challenge,
		});
	}

	return options;
}

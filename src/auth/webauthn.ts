import {
	type AuthenticatorTransportFuture,
	generateAuthenticationOptions,
	generateRegistrationOptions,
} from "@simplewebauthn/server";
import type { WebAuthnConfig } from "../config/env";
import type { Database } from "../db/client";
import { createChallenge } from "./challenges";

export interface UserCredentialSummary {
	credentialId: string;
	transports?: AuthenticatorTransportFuture[] | null | undefined;
	revokedAt: Date | null;
}

interface BuildRegistrationOptionsParams {
	config: WebAuthnConfig;
	user: {
		id: string;
		displayName: string;
	};
	existingCredentials?: UserCredentialSummary[] | undefined;
}

async function buildRegistrationOptions({
	config,
	user,
	existingCredentials = [],
}: BuildRegistrationOptionsParams) {
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

export interface GenerateRegistrationOptionsParams {
	db: Database;
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
	const options = await buildRegistrationOptions({
		config,
		user,
		existingCredentials,
	});

	// Fail-closed: Challenge MUST be persisted before returning options
	await createChallenge({
		db,
		userId: user.id,
		purpose: "REGISTRATION",
		challenge: options.challenge,
	});

	return options;
}

interface BuildAuthenticationOptionsParams {
	config: WebAuthnConfig;
	existingCredentials?: UserCredentialSummary[] | undefined;
}

async function buildAuthenticationOptions({
	config,
	existingCredentials = [],
}: BuildAuthenticationOptionsParams) {
	const activeCredentials = existingCredentials.filter(
		(c) => c.revokedAt === null,
	);

	return generateAuthenticationOptions({
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
}

export interface GenerateAuthenticationOptionsParams {
	db: Database;
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
	const options = await buildAuthenticationOptions({
		config,
		existingCredentials,
	});

	// Fail-closed: Challenge MUST be persisted before returning options
	await createChallenge({
		db,
		userId: user.id,
		purpose: "AUTHENTICATION",
		challenge: options.challenge,
	});

	return options;
}

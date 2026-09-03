import {
	type AuthenticatorTransportFuture,
	generateAuthenticationOptions,
} from "@simplewebauthn/server";
import type { WebAuthnConfig } from "../config/env";
import type { Database } from "../db/client";
import { createAuthenticationChallenge } from "./challenges";

export interface UserCredentialSummary {
	credentialId: string;
	transports?: AuthenticatorTransportFuture[] | null | undefined;
	revokedAt: Date | null;
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
	await createAuthenticationChallenge({
		db,
		userId: user.id,
		challenge: options.challenge,
	});

	return options;
}

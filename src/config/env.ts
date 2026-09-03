export interface AppEnv {
	DATABASE_URL?: string | undefined;
	WEBAUTHN_RP_ID?: string | undefined;
	WEBAUTHN_RP_NAME?: string | undefined;
	WEBAUTHN_ORIGIN?: string | undefined;
}

export function getDatabaseUrl(env: AppEnv): string {
	const rawUrl = env.DATABASE_URL;
	if (!rawUrl || rawUrl.trim() === "") {
		throw new Error("DATABASE_URL is required");
	}

	return rawUrl.trim();
}

export interface WebAuthnConfig {
	rpID: string;
	rpName: string;
	origin: string;
}

export function getWebAuthnConfig(env: AppEnv): WebAuthnConfig {
	const rpID = env.WEBAUTHN_RP_ID;
	if (!rpID || rpID.trim() === "") {
		throw new Error("WEBAUTHN_RP_ID is required");
	}

	const rpName = env.WEBAUTHN_RP_NAME;
	if (!rpName || rpName.trim() === "") {
		throw new Error("WEBAUTHN_RP_NAME is required");
	}

	const origin = env.WEBAUTHN_ORIGIN;
	if (!origin || origin.trim() === "") {
		throw new Error("WEBAUTHN_ORIGIN is required");
	}

	return {
		rpID: rpID.trim(),
		rpName: rpName.trim(),
		origin: origin.trim(),
	};
}

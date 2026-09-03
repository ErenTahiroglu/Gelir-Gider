export interface RateLimitBinding {
	limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface AppEnv {
	DATABASE_URL?: string | undefined;
	WEBAUTHN_RP_ID?: string | undefined;
	WEBAUTHN_RP_NAME?: string | undefined;
	WEBAUTHN_ORIGIN?: string | undefined;
	BOOTSTRAP_TOKEN_HASH?: string | undefined;
	AUTH_RATE_LIMITER?: RateLimitBinding | undefined;
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

const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

export function getBootstrapTokenHash(env: AppEnv): string {
	const rawHash = env.BOOTSTRAP_TOKEN_HASH;
	if (!rawHash || rawHash.trim() === "") {
		throw new Error("BOOTSTRAP_TOKEN_HASH is required");
	}

	const trimmed = rawHash.trim();
	if (!HEX_64_PATTERN.test(trimmed)) {
		throw new Error(
			"BOOTSTRAP_TOKEN_HASH must be exactly 64 lowercase hexadecimal characters",
		);
	}

	return trimmed;
}

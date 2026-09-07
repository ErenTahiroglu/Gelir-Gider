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
	WEB_PUSH_VAPID_SUBJECT?: string | undefined;
	WEB_PUSH_VAPID_PUBLIC_KEY?: string | undefined;
	WEB_PUSH_VAPID_PRIVATE_KEY?: string | undefined;
	BACKUP_ENCRYPTION_KEY?: string | undefined;
	BACKUP_ENCRYPTION_KEY_ID?: string | undefined;
	BACKUP_BUCKET?: R2Bucket | undefined;
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

const BASE64URL_STRICT_PATTERN = /^[A-Za-z0-9_-]+$/;

function decodeBase64UrlLength(value: string): number {
	if (!BASE64URL_STRICT_PATTERN.test(value)) {
		throw new Error("value must be strict base64url (no padding, no +/)");
	}
	const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
	const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		throw new Error("value is not valid base64url");
	}
	return binary.length;
}

export interface WebPushVapidConfig {
	subject: string;
	publicKey: string;
	privateKey: string;
}

/**
 * Validates the Web Push VAPID environment configuration. Called LAZILY --
 * only from inside the Web Push transport at the point an actual push
 * delivery is attempted -- never eagerly at Worker module load, since most
 * requests never need it. Throws a plain `Error` (never a raw crypto
 * exception, and never echoes the private key value); the notification
 * domain's boundary layer wraps this into a sanitized
 * `NOTIFICATION_PUSH_CONFIG_INVALID` error.
 */
export function getWebPushVapidConfig(env: AppEnv): WebPushVapidConfig {
	const rawSubject = env.WEB_PUSH_VAPID_SUBJECT;
	if (!rawSubject || rawSubject.trim() === "") {
		throw new Error("WEB_PUSH_VAPID_SUBJECT is required");
	}
	const subject = rawSubject.trim();
	const isMailto =
		subject.startsWith("mailto:") && subject.length > "mailto:".length;
	let isHttps = false;
	if (!isMailto) {
		try {
			isHttps = new URL(subject).protocol === "https:";
		} catch {
			isHttps = false;
		}
	}
	if (!isMailto && !isHttps) {
		throw new Error(
			"WEB_PUSH_VAPID_SUBJECT must be a mailto: URI or an https:// URL",
		);
	}

	const rawPublicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY;
	if (!rawPublicKey || rawPublicKey.trim() === "") {
		throw new Error("WEB_PUSH_VAPID_PUBLIC_KEY is required");
	}
	const publicKey = rawPublicKey.trim();
	let publicKeyLength: number;
	try {
		publicKeyLength = decodeBase64UrlLength(publicKey);
	} catch {
		throw new Error("WEB_PUSH_VAPID_PUBLIC_KEY must be valid base64url");
	}
	if (publicKeyLength !== 65) {
		throw new Error(
			"WEB_PUSH_VAPID_PUBLIC_KEY must decode to a 65-byte uncompressed P-256 public key",
		);
	}

	const rawPrivateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY;
	if (!rawPrivateKey || rawPrivateKey.trim() === "") {
		throw new Error("WEB_PUSH_VAPID_PRIVATE_KEY is required");
	}
	const privateKey = rawPrivateKey.trim();
	let privateKeyLength: number;
	try {
		privateKeyLength = decodeBase64UrlLength(privateKey);
	} catch {
		throw new Error("WEB_PUSH_VAPID_PRIVATE_KEY must be valid base64url");
	}
	if (privateKeyLength !== 32) {
		throw new Error(
			"WEB_PUSH_VAPID_PRIVATE_KEY must decode to a 32-byte P-256 private scalar",
		);
	}

	return { subject, publicKey, privateKey };
}

/**
 * Returns ONLY the VAPID public key, for a future frontend subscription-setup
 * flow. Never exposes the private key. Throws a plain `Error` if
 * unconfigured (same lazy-validation discipline as `getWebPushVapidConfig`).
 */
export function getWebPushVapidPublicKey(env: AppEnv): string {
	return getWebPushVapidConfig(env).publicKey;
}

function decodeBase64UrlStrictBytes(value: string): Uint8Array {
	if (!BASE64URL_STRICT_PATTERN.test(value)) {
		throw new Error("value must be strict base64url (no padding, no +/)");
	}
	const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
	const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		throw new Error("value is not valid base64url");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Validates and decodes `BACKUP_ENCRYPTION_KEY`: strict unpadded base64url
 * (no `+`, `/`, `=`) that decodes to EXACTLY 32 bytes (an AES-256-GCM key).
 * Lazy -- called only from inside the backup service/crypto boundary at the
 * point a backup or restore is actually attempted, never eagerly at Worker
 * module load. Throws a plain `Error` and never echoes the raw secret value.
 */
export function getBackupEncryptionKey(env: AppEnv): Uint8Array {
	const raw = env.BACKUP_ENCRYPTION_KEY;
	if (!raw || raw.trim() === "") {
		throw new Error("BACKUP_ENCRYPTION_KEY is required");
	}
	const trimmed = raw.trim();
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64UrlStrictBytes(trimmed);
	} catch {
		throw new Error("BACKUP_ENCRYPTION_KEY must be valid base64url");
	}
	if (bytes.length !== 32) {
		throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes");
	}
	return bytes;
}

/**
 * Bounded identifier charset for `BACKUP_ENCRYPTION_KEY_ID`, matching the
 * same convention used elsewhere in this codebase for bounded identifiers
 * (e.g. `BASE64URL_STRICT_PATTERN` above, `BASE64URL_PATTERN` in
 * `src/auth/session-cookie.ts`/`src/notifications/calendar.ts`) and the same
 * `MAX_KEY_ID_LENGTH` bound `src/backups/crypto.ts`'s `assertEnvelopeShape`
 * already enforces on a decrypted envelope's `keyId`.
 */
const BACKUP_KEY_ID_MAX_LENGTH = 64;
const BACKUP_KEY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Returns the active backup encryption key identifier. `BACKUP_ENCRYPTION_KEY_ID`
 * is OPTIONAL -- if unset it defaults to `"v1"`, since a single-operator
 * deployment starting out has exactly one key generation. Once a key is ever
 * rotated, the operator is expected to set this explicitly so newly created
 * backups carry the correct identifier (old backups keep whatever keyId they
 * were encrypted under, recorded in their own envelope header).
 *
 * When explicitly provided, the value is validated EAGERLY here (length
 * 1-64, restricted to a safe bounded identifier charset) -- BEFORE it can
 * ever reach `runDatabaseBackup`. Without this, a malformed keyId would only
 * be caught much later, inside Phase 2's own envelope read-back
 * verification (`assertEnvelopeShape`'s `MAX_KEY_ID_LENGTH` bound) -- after a
 * STARTED reservation, a full snapshot/encrypt/upload cycle, and an orphaned
 * uploaded object (Section B) had already been produced for what was really
 * just a config error, knowable up front. `src/index.ts`'s scheduled handler
 * already calls all `getBackupXxx(env)` functions (this one included) in a
 * try/catch BEFORE any reservation is attempted, so throwing here
 * automatically gets the "zero backup reservation, zero R2 call" behavior.
 */
export function getBackupKeyId(env: AppEnv): string {
	const raw = env.BACKUP_ENCRYPTION_KEY_ID;
	if (!raw || raw.trim() === "") {
		return "v1";
	}
	const trimmed = raw.trim();
	if (trimmed.length > BACKUP_KEY_ID_MAX_LENGTH) {
		throw new Error(
			`BACKUP_ENCRYPTION_KEY_ID must be at most ${BACKUP_KEY_ID_MAX_LENGTH} characters`,
		);
	}
	if (!BACKUP_KEY_ID_PATTERN.test(trimmed)) {
		throw new Error(
			"BACKUP_ENCRYPTION_KEY_ID must contain only letters, digits, underscores, or hyphens",
		);
	}
	return trimmed;
}

/**
 * Lazily resolves the R2 bucket binding used for encrypted database backups.
 * Throws a plain `Error` if the binding is absent (e.g. local dev without an
 * R2 binding configured) -- never attempted eagerly at module load.
 */
export function getBackupBucket(env: AppEnv): R2Bucket {
	if (!env.BACKUP_BUCKET) {
		throw new Error("BACKUP_BUCKET binding is required");
	}
	return env.BACKUP_BUCKET;
}

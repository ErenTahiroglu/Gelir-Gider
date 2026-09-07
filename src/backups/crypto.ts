import { BackupError } from "./errors";

/**
 * Versioned encrypted-backup envelope format ("GG_BACKUP_V1").
 *
 * A plain JSON header + base64 ciphertext, NOT a hand-rolled binary format --
 * simpler and equally sufficient, since every field the spec requires
 * (magic, version, backupId, createdAt, keyId, algorithm, IV, ciphertext,
 * ciphertext hash) is carried in plaintext-visible metadata anyway. AES-GCM
 * itself is what actually protects the confidentiality/integrity of the
 * PAYLOAD; the header fields are bound into the ciphertext's authentication
 * tag via Additional Authenticated Data (AAD), so tampering with any of them
 * makes decryption fail even though they are visible plaintext.
 */
export const BACKUP_ENVELOPE_MAGIC = "GG_BACKUP";
export const BACKUP_ENVELOPE_FORMAT_VERSION = "V1";
export const BACKUP_ENVELOPE_ALGORITHM = "AES-256-GCM";

const IV_BYTES = 12;

export interface BackupEnvelope {
	magic: typeof BACKUP_ENVELOPE_MAGIC;
	formatVersion: typeof BACKUP_ENVELOPE_FORMAT_VERSION;
	backupId: string;
	createdAt: string;
	keyId: string;
	algorithm: typeof BACKUP_ENVELOPE_ALGORITHM;
	ivBase64: string;
	ciphertextBase64: string;
	ciphertextSha256: string;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope field is not valid base64",
		);
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		bytes as unknown as BufferSource,
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * The AAD bound into the AES-GCM authentication tag: a fixed, deterministic
 * JSON serialization of exactly
 * `{ magic, formatVersion, backupId, createdAt, keyId, algorithm }` (in this
 * key order). Any mutation of the IV, ciphertext, or ANY of these six header
 * fields makes AES-GCM tag verification fail on decrypt -- `keyId` and
 * `algorithm` are included (as of Phase 18-R1) alongside the original four so
 * an attacker with write access to storage cannot swap either field without
 * invalidating the auth tag (a defense-in-depth gap, not a cryptographic
 * attack on its own, since neither field is secret).
 */
function buildAad(header: {
	magic: string;
	formatVersion: string;
	backupId: string;
	createdAt: string;
	keyId: string;
	algorithm: string;
}): Uint8Array {
	const json = JSON.stringify({
		magic: header.magic,
		formatVersion: header.formatVersion,
		backupId: header.backupId,
		createdAt: header.createdAt,
		keyId: header.keyId,
		algorithm: header.algorithm,
	});
	return new TextEncoder().encode(json);
}

async function importAesGcmKey(key: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		key as unknown as BufferSource,
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

export interface EncryptBackupPayloadParams {
	plaintext: Uint8Array | string;
	backupId: string;
	createdAt: string;
	key: Uint8Array;
	keyId: string;
}

/**
 * Encrypts a backup snapshot plaintext into a `GG_BACKUP_V1` envelope using
 * AES-256-GCM with a fresh random 12-byte IV per call (so encrypting the
 * SAME plaintext twice produces DIFFERENT ciphertext).
 */
export async function encryptBackupPayload(
	params: EncryptBackupPayloadParams,
): Promise<BackupEnvelope> {
	const plaintextBytes =
		typeof params.plaintext === "string"
			? new TextEncoder().encode(params.plaintext)
			: params.plaintext;

	if (params.key.length !== 32) {
		throw new BackupError(
			"BACKUP_ENCRYPTION_FAILED",
			"Backup encryption key must be exactly 32 bytes",
		);
	}

	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const aad = buildAad({
		magic: BACKUP_ENVELOPE_MAGIC,
		formatVersion: BACKUP_ENVELOPE_FORMAT_VERSION,
		backupId: params.backupId,
		createdAt: params.createdAt,
		keyId: params.keyId,
		algorithm: BACKUP_ENVELOPE_ALGORITHM,
	});

	let cipherBuffer: ArrayBuffer;
	try {
		const cryptoKey = await importAesGcmKey(params.key);
		cipherBuffer = await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv: iv as unknown as BufferSource,
				additionalData: aad as unknown as BufferSource,
			},
			cryptoKey,
			plaintextBytes as unknown as BufferSource,
		);
	} catch {
		throw new BackupError(
			"BACKUP_ENCRYPTION_FAILED",
			"Backup payload encryption failed",
		);
	}

	const ciphertextBytes = new Uint8Array(cipherBuffer);
	const ciphertextSha256 = await sha256Hex(ciphertextBytes);

	return {
		magic: BACKUP_ENVELOPE_MAGIC,
		formatVersion: BACKUP_ENVELOPE_FORMAT_VERSION,
		backupId: params.backupId,
		createdAt: params.createdAt,
		keyId: params.keyId,
		algorithm: BACKUP_ENVELOPE_ALGORITHM,
		ivBase64: bytesToBase64(iv),
		ciphertextBase64: bytesToBase64(ciphertextBytes),
		ciphertextSha256,
	};
}

/** Matches `deriveBackupId` in `src/backups/service.ts`: an 8-digit `YYYYMMDD`. */
const BACKUP_ID_SHAPE = /^\d{8}$/;

/** Bounded, matching how other identifiers (e.g. keyId elsewhere) are constrained. */
const MAX_KEY_ID_LENGTH = 64;

const EXPECTED_ENVELOPE_KEYS = [
	"magic",
	"formatVersion",
	"backupId",
	"createdAt",
	"keyId",
	"algorithm",
	"ivBase64",
	"ciphertextBase64",
	"ciphertextSha256",
] as const;

function assertEnvelopeShape(
	envelope: unknown,
): asserts envelope is BackupEnvelope {
	if (typeof envelope !== "object" || envelope === null) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope must be an object",
		);
	}
	const e = envelope as Record<string, unknown>;

	// The envelope must have EXACTLY the expected key set -- no extra/missing
	// top-level keys, guarding against a malformed/tampered envelope
	// smuggling extra data.
	const actualKeys = Object.keys(e);
	const expectedKeySet = new Set<string>(EXPECTED_ENVELOPE_KEYS);
	if (
		actualKeys.length !== EXPECTED_ENVELOPE_KEYS.length ||
		!actualKeys.every((key) => expectedKeySet.has(key))
	) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope does not have exactly the expected set of fields",
		);
	}

	for (const field of EXPECTED_ENVELOPE_KEYS) {
		if (typeof e[field] !== "string" || e[field] === "") {
			throw new BackupError(
				"BACKUP_INVALID_ENVELOPE",
				`Backup envelope field "${field}" is missing or invalid`,
			);
		}
	}
	if (e.magic !== BACKUP_ENVELOPE_MAGIC) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope magic value is not recognized",
		);
	}
	if (e.formatVersion !== BACKUP_ENVELOPE_FORMAT_VERSION) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope format version is not supported",
		);
	}
	if (e.algorithm !== BACKUP_ENVELOPE_ALGORITHM) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope algorithm is not supported",
		);
	}
	if (!/^[0-9a-f]{64}$/.test(e.ciphertextSha256 as string)) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope ciphertext hash is not a valid SHA-256 hex digest",
		);
	}
	if (!BACKUP_ID_SHAPE.test(e.backupId as string)) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope backupId is not a valid YYYYMMDD identifier",
		);
	}
	if (Number.isNaN(Date.parse(e.createdAt as string))) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope createdAt is not a valid timestamp",
		);
	}
	if ((e.keyId as string).length > MAX_KEY_ID_LENGTH) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup envelope keyId exceeds the maximum allowed length",
		);
	}
	const ivBytes = base64ToBytes(e.ivBase64 as string);
	if (ivBytes.length !== IV_BYTES) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			`Backup envelope IV must decode to exactly ${IV_BYTES} bytes`,
		);
	}
}

export interface DecryptBackupPayloadParams {
	envelope: BackupEnvelope;
	key: Uint8Array;
}

/**
 * Decrypts a `GG_BACKUP_V1` envelope. Throws `BACKUP_INVALID_ENVELOPE` for a
 * malformed/unrecognized envelope shape/magic/version, and
 * `BACKUP_VERIFICATION_FAILED` when AES-GCM authentication fails (wrong key,
 * or ANY tampering of the IV/ciphertext/AAD-bound header fields) -- the
 * native `crypto.subtle.decrypt` rejection IS the tamper check.
 */
export async function decryptBackupPayload(
	params: DecryptBackupPayloadParams,
): Promise<Uint8Array> {
	assertEnvelopeShape(params.envelope);
	const { envelope, key } = params;

	if (key.length !== 32) {
		throw new BackupError(
			"BACKUP_VERIFICATION_FAILED",
			"Backup decryption key must be exactly 32 bytes",
		);
	}

	// Recompute the ciphertext hash BEFORE attempting decryption -- a cheap,
	// clear failure mode distinct from an AES-GCM auth-tag mismatch.
	const ciphertextBytes = base64ToBytes(envelope.ciphertextBase64);
	const recomputedHash = await sha256Hex(ciphertextBytes);
	if (recomputedHash !== envelope.ciphertextSha256) {
		throw new BackupError(
			"BACKUP_VERIFICATION_FAILED",
			"Backup envelope ciphertext hash does not match its recorded digest",
		);
	}

	const iv = base64ToBytes(envelope.ivBase64);
	const aad = buildAad({
		magic: envelope.magic,
		formatVersion: envelope.formatVersion,
		backupId: envelope.backupId,
		createdAt: envelope.createdAt,
		keyId: envelope.keyId,
		algorithm: envelope.algorithm,
	});

	try {
		const cryptoKey = await importAesGcmKey(key);
		const plainBuffer = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: iv as unknown as BufferSource,
				additionalData: aad as unknown as BufferSource,
			},
			cryptoKey,
			ciphertextBytes as unknown as BufferSource,
		);
		return new Uint8Array(plainBuffer);
	} catch {
		throw new BackupError(
			"BACKUP_VERIFICATION_FAILED",
			"Backup payload decryption failed (wrong key or tampered envelope)",
		);
	}
}

/**
 * Compares an envelope's recorded `keyId` against the keyId an operator
 * believes it should be encrypted under. Intended to be checked by callers
 * (notably the restore script) BEFORE attempting `decryptBackupPayload`, so
 * a keyId mismatch can be surfaced as a clear warning/abort rather than an
 * opaque AES-GCM auth-tag failure. Returns `true` on match.
 */
export function envelopeKeyIdMatches(
	envelope: Pick<BackupEnvelope, "keyId">,
	expectedKeyId: string,
): boolean {
	return envelope.keyId === expectedKeyId;
}

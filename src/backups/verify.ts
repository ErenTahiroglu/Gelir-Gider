import { type BackupEnvelope, decryptBackupPayload } from "./crypto";
import { BackupError } from "./errors";
import type { BackupSnapshotPayload } from "./manifest";
import { verifySnapshotAgainstManifest } from "./manifest";

/**
 * Sanitized backup summary: safe to log, print, or return from any
 * operator-facing surface. NEVER includes the encryption key or any
 * decrypted financial row data -- for that, use `decryptAndParseBackup`
 * (restore-only, never called from the Worker's request/response path).
 */
export interface BackupSummary {
	backupId: string;
	createdAt: string;
	keyId: string;
	formatVersion: string;
	tableCounts: Record<string, number>;
	plaintextSizeBytes: number;
	ciphertextSizeBytes: number;
}

function parseSnapshotPayload(plaintext: Uint8Array): BackupSnapshotPayload {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			plaintext,
		);
	} catch {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup plaintext is not valid UTF-8",
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup plaintext is not valid JSON",
		);
	}

	if (typeof parsed !== "object" || parsed === null) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup plaintext must decode to an object",
		);
	}
	const obj = parsed as Record<string, unknown>;
	if (
		typeof obj.manifest !== "object" ||
		obj.manifest === null ||
		!Array.isArray(obj.tables)
	) {
		throw new BackupError(
			"BACKUP_INVALID_ENVELOPE",
			"Backup plaintext is missing a manifest or tables array",
		);
	}

	return obj as unknown as BackupSnapshotPayload;
}

function ciphertextSizeBytes(envelope: BackupEnvelope): number {
	// base64 decoded size approximation: 3/4 of the base64 string length
	// (minus padding); exact enough for a sanitized summary, never used for
	// integrity decisions (the SHA-256 digest check covers that).
	const raw = envelope.ciphertextBase64;
	const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
	return Math.floor((raw.length * 3) / 4) - padding;
}

/**
 * Full end-to-end verification of an encrypted backup envelope: magic and
 * format-version check, envelope header shape check, ciphertext SHA-256
 * recomputation-and-compare, AES-GCM decrypt (authenticates the ciphertext
 * and every AAD-bound header field), manifest parse, per-table row
 * count/hash check, and overall manifest hash check. Returns ONLY sanitized
 * metadata -- never the key, never decrypted financial rows.
 */
export async function verifyEncryptedBackupSummary(
	envelope: BackupEnvelope,
	key: Uint8Array,
): Promise<BackupSummary> {
	const plaintext = await decryptBackupPayload({ envelope, key });
	const payload = parseSnapshotPayload(plaintext);
	await verifySnapshotAgainstManifest(payload);

	const tableCounts: Record<string, number> = {};
	for (const table of payload.manifest.tables) {
		tableCounts[table.tableName] = table.rowCount;
	}

	return {
		backupId: envelope.backupId,
		createdAt: envelope.createdAt,
		keyId: envelope.keyId,
		formatVersion: envelope.formatVersion,
		tableCounts,
		plaintextSizeBytes: plaintext.length,
		ciphertextSizeBytes: ciphertextSizeBytes(envelope),
	};
}

/**
 * Restore-only: decrypts, parses, and manifest-verifies a backup envelope,
 * returning the FULL snapshot payload including decrypted financial rows.
 * Never call this from any HTTP-reachable path -- it exists solely for
 * `scripts/restore-backup.ts`.
 */
export async function decryptAndParseBackup(
	envelope: BackupEnvelope,
	key: Uint8Array,
): Promise<BackupSnapshotPayload> {
	const plaintext = await decryptBackupPayload({ envelope, key });
	const payload = parseSnapshotPayload(plaintext);
	await verifySnapshotAgainstManifest(payload);
	return payload;
}

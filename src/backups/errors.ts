export const BACKUP_ERROR_CODES = [
	"BACKUP_TOO_LARGE",
	"BACKUP_SNAPSHOT_FAILED",
	"BACKUP_ENCRYPTION_FAILED",
	"BACKUP_UPLOAD_FAILED",
	"BACKUP_VERIFICATION_FAILED",
	"BACKUP_ANCHOR_FAILED",
	"BACKUP_INVALID_ENVELOPE",
] as const;

export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

/**
 * Sanitized backup-domain error. `message` must NEVER embed a raw
 * exception's message, a stack trace, or any decrypted/plaintext financial
 * data -- only a fixed, safe, human-readable description of the failure
 * class. Mirrors `NotificationError`/`CampaignError`'s established shape.
 */
export class BackupError extends Error {
	readonly code: BackupErrorCode;

	constructor(code: BackupErrorCode, message: string) {
		super(message);
		this.name = "BackupError";
		this.code = code;
		Object.setPrototypeOf(this, BackupError.prototype);
	}
}

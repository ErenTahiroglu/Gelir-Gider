import { NotificationError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Europe/Istanbul has been a fixed UTC+03:00 offset with no DST since 2016. */
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Derives the Europe/Istanbul local calendar date ("YYYY-MM-DD") and local
 * hour (0-23) from an arbitrary UTC instant. Mirrors the fixed-offset
 * approach already established by
 * `month-close/calendar.ts::getMonthCloseIstanbulPeriodBoundaries`.
 */
export function getIstanbulLocalDateAndHour(instant: Date): {
	localDate: string;
	localHour: number;
} {
	if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"scheduledAt must be a valid Date object",
		);
	}
	const shifted = new Date(instant.getTime() + ISTANBUL_OFFSET_MS);
	const year = shifted.getUTCFullYear();
	const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const day = String(shifted.getUTCDate()).padStart(2, "0");
	return {
		localDate: `${year}-${month}-${day}`,
		localHour: shifted.getUTCHours(),
	};
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validates a "YYYY-MM-DD" local-date string used for scheduled_local_date /
 * dueDate comparisons. Enforces genuine Gregorian calendar validity (Section
 * 28) via a `Date.UTC` round-trip -- not merely regex shape -- so
 * "2026-02-30", "2026-04-31", and "2026-13-01" are all rejected, mirroring
 * `short-term-goals/calendar.ts::validateGregorianDate`.
 */
export function validateNotificationLocalDate(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} must be a string in YYYY-MM-DD format`,
		);
	}
	const trimmed = value.trim();
	const match = LOCAL_DATE_PATTERN.exec(trimmed);
	if (!match) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} must match YYYY-MM-DD format: "${value}"`,
		);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const roundTrip = new Date(Date.UTC(year, month - 1, day));
	if (
		roundTrip.getUTCFullYear() !== year ||
		roundTrip.getUTCMonth() !== month - 1 ||
		roundTrip.getUTCDate() !== day
	) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} is not a valid Gregorian calendar date: "${trimmed}"`,
		);
	}
	return trimmed;
}

/**
 * Converts a validated Europe/Istanbul local-date string ("YYYY-MM-DD") into
 * the UTC instant corresponding to 12:00 local time on that date. Istanbul
 * is a fixed UTC+03:00 offset year-round, so 12:00 local == 09:00 UTC on the
 * same calendar date.
 */
export function istanbulNoonToUtcInstant(localDate: string): Date {
	validateNotificationLocalDate(localDate, "localDate");
	return new Date(`${localDate}T12:00:00+03:00`);
}

/**
 * Returns true when the given Europe/Istanbul local hour is at or after the
 * 12:00 target initial-delivery hour (Section 3 cron strategy).
 */
export function isAtOrAfterNotificationDeliveryHour(
	localHour: number,
): boolean {
	return localHour >= 12;
}

export function validateNotificationCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (!UUID_PATTERN.test(trimmed)) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}
	return trimmed.toLowerCase();
}

export function validateNotificationOccurredAt(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

export function validateNotificationIdempotencyKey(value: unknown): string {
	if (typeof value !== "string") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"idempotencyKey must be a string",
		);
	}
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 128) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"idempotencyKey must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

export function validateNotificationExpectedRevisionNo(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer",
		);
	}
	return value;
}

export function validateNotificationOptionalText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} must be a string when provided`,
		);
	}
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > maxLength) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} must be between 1 and ${maxLength} characters when provided`,
		);
	}
	return trimmed;
}

// ============================================================================
// Push subscription input validation (Section 7)
// ============================================================================

const MAX_ENDPOINT_LENGTH = 2048;

/**
 * Validates the push subscription `endpoint`: string, trimmed non-empty,
 * HTTPS-only, max length 2048, no embedded userinfo (`user:pass@host`).
 * Preserves path/query exactly -- does not "normalize away" meaningful
 * parts, it only trims surrounding whitespace.
 */
export function validateNotificationPushEndpoint(value: unknown): string {
	if (typeof value !== "string") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"endpoint must be a string",
		);
	}
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > MAX_ENDPOINT_LENGTH) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`endpoint must be between 1 and ${MAX_ENDPOINT_LENGTH} characters`,
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"endpoint must be a valid absolute URL",
		);
	}
	if (parsed.protocol !== "https:") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"endpoint must use https://",
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"endpoint must not contain embedded userinfo",
		);
	}
	return trimmed;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Strictly decodes a base64url string (no padding, no `+`/`/`) into raw
 * bytes. Rejects malformed input rather than throwing a raw crypto/runtime
 * exception.
 */
export function decodeBase64Url(value: string, fieldName: string): Uint8Array {
	if (typeof value !== "string" || value.length === 0) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} must be a non-empty base64url string`,
		);
	}
	if (!BASE64URL_PATTERN.test(value)) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} must be strict base64url (no padding, no +/ characters)`,
		);
	}
	const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
	const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`${fieldName} is not valid base64url`,
		);
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	const base64 = btoa(binary);
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Validates `p256dh`: strict base64url decoding to exactly 65 bytes with a
 * leading 0x04 byte (the uncompressed P-256 public key shape). Structural
 * validation only -- does not verify the point is actually on-curve. Callers
 * that need cryptographic proof (Section C) must additionally call
 * `assertP256dhOnCurve` before any DB call.
 */
export function validateNotificationP256dh(value: unknown): string {
	if (typeof value !== "string") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"p256dh must be a string",
		);
	}
	const trimmed = value.trim();
	const bytes = decodeBase64Url(trimmed, "p256dh");
	if (bytes.length !== 65 || bytes[0] !== 0x04) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"p256dh must decode to a 65-byte uncompressed P-256 public key (leading 0x04)",
		);
	}
	return trimmed;
}

/**
 * Phase 15-R1 Section C: proves the structurally-valid p256dh bytes are
 * actually an on-curve P-256 point, by attempting a real WebCrypto ECDH
 * import. `crypto.subtle.importKey` throws a raw `DOMException` for an
 * off-curve point (or any other cryptographically invalid encoding); that
 * raw exception is caught here and converted to a sanitized
 * `NotificationError` so it never escapes uncaught. Pure crypto -- zero DB
 * calls -- so it can run before any transaction opens, alongside every other
 * "validate `unknown` before `db.transaction()`" check in this domain.
 */
export async function assertP256dhOnCurve(p256dh: string): Promise<void> {
	const bytes = decodeBase64Url(p256dh, "p256dh");
	try {
		await crypto.subtle.importKey(
			"raw",
			bytes,
			{ name: "ECDH", namedCurve: "P-256" },
			false,
			[],
		);
	} catch {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"p256dh is not a valid P-256 public key",
		);
	}
}

/**
 * Validates `auth`: strict base64url decoding to exactly 16 bytes (the Web
 * Push auth secret length per RFC 8291).
 */
export function validateNotificationAuth(value: unknown): string {
	if (typeof value !== "string") {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"auth must be a string",
		);
	}
	const trimmed = value.trim();
	const bytes = decodeBase64Url(trimmed, "auth");
	if (bytes.length !== 16) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"auth must decode to exactly 16 bytes",
		);
	}
	return trimmed;
}

/**
 * Computes the stable SHA-256 hex identity of a normalized endpoint string.
 * Used as the push_subscriptions anchor's `endpoint_hash`.
 */
export async function computeEndpointHash(endpoint: string): Promise<string> {
	const encoded = new TextEncoder().encode(endpoint);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function validateNotificationOptionalExpirationTime(
	value: unknown,
): Date | null {
	if (value === undefined || value === null) return null;
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"expirationTime must be a valid Date object when provided",
		);
	}
	return value;
}

const NOTIFICATION_TYPE_VALUES = new Set(["CREDIT_CARD_DUE"]);

export function validateNotificationOptionalType(
	value: unknown,
): "CREDIT_CARD_DUE" | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !NOTIFICATION_TYPE_VALUES.has(value)) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			`notification type must be one of CREDIT_CARD_DUE (or omitted): "${String(value)}"`,
		);
	}
	return value as "CREDIT_CARD_DUE";
}

/**
 * Phase 15-R1 Section H/27: strict runtime validation for the push
 * subscription `status` read filter. ONLY `undefined` means "omitted" --
 * `null`, `""`, whitespace, a number, an object, or any string other than
 * exactly "ACTIVE"/"DISABLED" is rejected with NOTIFICATION_INVALID_INPUT.
 * Never uses a truthiness check (`if (status)`), which would incorrectly
 * treat `""` as "omitted" rather than invalid.
 */
export function validateNotificationOptionalSubscriptionStatus(
	value: unknown,
): "ACTIVE" | "DISABLED" | undefined {
	if (value === undefined) return undefined;
	if (value === "ACTIVE" || value === "DISABLED") return value;
	throw new NotificationError(
		"NOTIFICATION_INVALID_INPUT",
		'status must be exactly "ACTIVE" or "DISABLED" when provided',
	);
}

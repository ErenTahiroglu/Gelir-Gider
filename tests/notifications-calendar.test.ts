import { describe, expect, it } from "vitest";
import {
	assertP256dhOnCurve,
	decodeBase64Url,
	encodeBase64Url,
	getIstanbulLocalDateAndHour,
	isAtOrAfterNotificationDeliveryHour,
	istanbulNoonToUtcInstant,
	validateNotificationAuth,
	validateNotificationCanonicalUuid,
	validateNotificationIdempotencyKey,
	validateNotificationLocalDate,
	validateNotificationOccurredAt,
	validateNotificationOptionalSubscriptionStatus,
	validateNotificationP256dh,
	validateNotificationPushEndpoint,
} from "../src/notifications/calendar";

describe("Istanbul local date/hour derivation (Phase 15, Section 2/3)", () => {
	it("derives 11:59 local as hour 11 (just before the delivery hour)", () => {
		// 2026-03-10T08:59:00Z + 03:00 = 11:59 local.
		const { localDate, localHour } = getIstanbulLocalDateAndHour(
			new Date("2026-03-10T08:59:00Z"),
		);
		expect(localDate).toBe("2026-03-10");
		expect(localHour).toBe(11);
		expect(isAtOrAfterNotificationDeliveryHour(localHour)).toBe(false);
	});

	it("derives 12:00 local as hour 12 (the delivery hour)", () => {
		const { localDate, localHour } = getIstanbulLocalDateAndHour(
			new Date("2026-03-10T09:00:00Z"),
		);
		expect(localDate).toBe("2026-03-10");
		expect(localHour).toBe(12);
		expect(isAtOrAfterNotificationDeliveryHour(localHour)).toBe(true);
	});

	it("derives 13:00 local as hour 13 (a same-day catch-up run)", () => {
		const { localHour } = getIstanbulLocalDateAndHour(
			new Date("2026-03-10T10:00:00Z"),
		);
		expect(localHour).toBe(13);
		expect(isAtOrAfterNotificationDeliveryHour(localHour)).toBe(true);
	});

	it("rolls the local date over at Istanbul midnight (UTC 21:00 the prior day)", () => {
		const { localDate, localHour } = getIstanbulLocalDateAndHour(
			new Date("2026-03-09T21:00:00Z"),
		);
		expect(localDate).toBe("2026-03-10");
		expect(localHour).toBe(0);
	});

	it("stays on the previous local date just before midnight (UTC 20:59)", () => {
		const { localDate, localHour } = getIstanbulLocalDateAndHour(
			new Date("2026-03-09T20:59:00Z"),
		);
		expect(localDate).toBe("2026-03-09");
		expect(localHour).toBe(23);
	});

	it("rejects an invalid Date", () => {
		expect(() => getIstanbulLocalDateAndHour(new Date("not-a-date"))).toThrow();
	});
});

describe("istanbulNoonToUtcInstant (Section 11)", () => {
	it("converts 12:00 Istanbul local to 09:00 UTC on the same calendar date", () => {
		const instant = istanbulNoonToUtcInstant("2026-03-10");
		expect(instant.toISOString()).toBe("2026-03-10T09:00:00.000Z");
	});

	it("rejects a malformed local date", () => {
		expect(() => istanbulNoonToUtcInstant("2026-3-1")).toThrow();
	});
});

describe("validateNotificationLocalDate", () => {
	it("accepts a well-formed date", () => {
		expect(validateNotificationLocalDate("2026-01-05", "d")).toBe("2026-01-05");
	});
	it("rejects a non-string", () => {
		expect(() => validateNotificationLocalDate(20260105, "d")).toThrow();
	});
	it("rejects a malformed date", () => {
		expect(() => validateNotificationLocalDate("01-05-2026", "d")).toThrow();
	});

	// ------------------------------------------------------------------
	// Phase 15-R1 Section 28: strict Gregorian calendar validity, not just
	// regex shape.
	// ------------------------------------------------------------------
	it("accepts a genuine leap day", () => {
		expect(validateNotificationLocalDate("2028-02-29", "d")).toBe("2028-02-29");
	});
	it("rejects a non-existent leap day in a non-leap year", () => {
		expect(() => validateNotificationLocalDate("2026-02-29", "d")).toThrow();
	});
	it("rejects February 30th", () => {
		expect(() => validateNotificationLocalDate("2026-02-30", "d")).toThrow();
	});
	it("rejects April 31st", () => {
		expect(() => validateNotificationLocalDate("2026-04-31", "d")).toThrow();
	});
	it("rejects month 13", () => {
		expect(() => validateNotificationLocalDate("2026-13-01", "d")).toThrow();
	});
	it("rejects day 00 and month 00", () => {
		expect(() => validateNotificationLocalDate("2026-00-10", "d")).toThrow();
		expect(() => validateNotificationLocalDate("2026-01-00", "d")).toThrow();
	});
});

describe("validateNotificationOptionalSubscriptionStatus (Section 27)", () => {
	it("returns undefined only for undefined", () => {
		expect(validateNotificationOptionalSubscriptionStatus(undefined)).toBe(
			undefined,
		);
	});
	it("accepts exactly ACTIVE and DISABLED", () => {
		expect(validateNotificationOptionalSubscriptionStatus("ACTIVE")).toBe(
			"ACTIVE",
		);
		expect(validateNotificationOptionalSubscriptionStatus("DISABLED")).toBe(
			"DISABLED",
		);
	});
	it("rejects null (not omission)", () => {
		expect(() =>
			validateNotificationOptionalSubscriptionStatus(null),
		).toThrow();
	});
	it("rejects an empty string (not omission -- no truthiness check)", () => {
		expect(() => validateNotificationOptionalSubscriptionStatus("")).toThrow();
	});
	it("rejects whitespace-only", () => {
		expect(() =>
			validateNotificationOptionalSubscriptionStatus("   "),
		).toThrow();
	});
	it("rejects an unknown status string", () => {
		expect(() =>
			validateNotificationOptionalSubscriptionStatus("BOGUS"),
		).toThrow();
	});
	it("rejects a number", () => {
		expect(() => validateNotificationOptionalSubscriptionStatus(1)).toThrow();
	});
	it("rejects an object", () => {
		expect(() =>
			validateNotificationOptionalSubscriptionStatus({ status: "ACTIVE" }),
		).toThrow();
	});
});

describe("validateNotificationCanonicalUuid / occurredAt / idempotencyKey", () => {
	const uuid = "019543ef-1111-7000-8000-000000000099";
	it("accepts and lowercases a valid UUID", () => {
		expect(
			validateNotificationCanonicalUuid(uuid.toUpperCase(), "userId"),
		).toBe(uuid);
	});
	it("rejects a non-UUID string", () => {
		expect(() =>
			validateNotificationCanonicalUuid("not-a-uuid", "userId"),
		).toThrow();
	});
	it("accepts a valid Date for occurredAt", () => {
		const d = new Date();
		expect(validateNotificationOccurredAt(d)).toBe(d);
	});
	it("rejects an invalid Date for occurredAt", () => {
		expect(() => validateNotificationOccurredAt(new Date("bad"))).toThrow();
	});
	it("rejects an empty idempotencyKey", () => {
		expect(() => validateNotificationIdempotencyKey("")).toThrow();
	});
	it("accepts a well-formed idempotencyKey", () => {
		expect(validateNotificationIdempotencyKey(" key-1 ")).toBe("key-1");
	});
});

describe("validateNotificationPushEndpoint (Section 7)", () => {
	it("accepts a well-formed https endpoint, preserving path/query", () => {
		const endpoint = "https://fcm.example.test/synthetic/abc123?x=1&y=2";
		expect(validateNotificationPushEndpoint(endpoint)).toBe(endpoint);
	});
	it("rejects a non-https endpoint", () => {
		expect(() =>
			validateNotificationPushEndpoint("http://fcm.example.test/abc"),
		).toThrow();
	});
	it("rejects embedded userinfo", () => {
		expect(() =>
			validateNotificationPushEndpoint(
				"https://user:pass@fcm.example.test/abc",
			),
		).toThrow();
	});
	it("rejects an over-length endpoint", () => {
		const endpoint = `https://fcm.example.test/${"a".repeat(2100)}`;
		expect(() => validateNotificationPushEndpoint(endpoint)).toThrow();
	});
	it("rejects a non-URL string", () => {
		expect(() => validateNotificationPushEndpoint("not a url")).toThrow();
	});
});

function synthP256dh(): string {
	const bytes = new Uint8Array(65);
	bytes[0] = 0x04;
	for (let i = 1; i < 65; i++) bytes[i] = i % 256;
	return encodeBase64Url(bytes);
}

function synthAuth(): string {
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) bytes[i] = i * 7 + 1;
	return encodeBase64Url(bytes);
}

describe("validateNotificationP256dh / validateNotificationAuth (Section 7)", () => {
	it("accepts a synthetic well-formed p256dh (65 bytes, leading 0x04)", () => {
		const p256dh = synthP256dh();
		expect(validateNotificationP256dh(p256dh)).toBe(p256dh);
	});
	it("rejects a p256dh with the wrong byte length", () => {
		const bytes = new Uint8Array(64);
		bytes[0] = 0x04;
		expect(() => validateNotificationP256dh(encodeBase64Url(bytes))).toThrow();
	});
	it("rejects a p256dh missing the 0x04 prefix", () => {
		const bytes = new Uint8Array(65);
		bytes[0] = 0x03;
		expect(() => validateNotificationP256dh(encodeBase64Url(bytes))).toThrow();
	});
	it("rejects non-base64url p256dh", () => {
		expect(() => validateNotificationP256dh("not+valid/base64==")).toThrow();
	});
	it("accepts a synthetic well-formed auth secret (16 bytes)", () => {
		const auth = synthAuth();
		expect(validateNotificationAuth(auth)).toBe(auth);
	});
	it("rejects an auth secret with the wrong byte length", () => {
		const bytes = new Uint8Array(15);
		expect(() => validateNotificationAuth(encodeBase64Url(bytes))).toThrow();
	});
});

describe("assertP256dhOnCurve (Phase 15-R1 Section C)", () => {
	it("accepts a genuine on-curve P-256 public key with zero DB calls", async () => {
		const keyPair = (await crypto.subtle.generateKey(
			{ name: "ECDH", namedCurve: "P-256" },
			true,
			["deriveBits"],
		)) as CryptoKeyPair;
		const raw = new Uint8Array(
			(await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
		);
		const p256dh = encodeBase64Url(raw);
		await expect(assertP256dhOnCurve(p256dh)).resolves.toBeUndefined();
	});

	it("rejects a structurally-valid but off-curve point as a sanitized NotificationError (never a raw DOMException)", async () => {
		// Correct shape (65 bytes, leading 0x04) but the x/y coordinates do
		// not satisfy the P-256 curve equation -- WebCrypto's raw ECDH
		// import throws a raw DOMException for this, which must never
		// escape uncaught.
		const p256dh = synthP256dh();
		let caught: unknown;
		try {
			await assertP256dhOnCurve(p256dh);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).name).toBe("NotificationError");
		expect((caught as { code?: string }).code).toBe(
			"NOTIFICATION_INVALID_INPUT",
		);
	});
});

describe("decodeBase64Url / encodeBase64Url round-trip", () => {
	it("round-trips arbitrary bytes", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
		const encoded = encodeBase64Url(bytes);
		expect(encoded).not.toMatch(/[+/=]/);
		const decoded = decodeBase64Url(encoded, "test");
		expect(Array.from(decoded)).toEqual(Array.from(bytes));
	});
});

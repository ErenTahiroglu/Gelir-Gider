import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config/env";
import {
	decodeBase64Url,
	encodeBase64Url,
} from "../src/notifications/calendar";
import {
	buildVapidHeaders,
	classifyPushResponseStatus,
	encryptWebPushPayload,
	WebPushTransport,
} from "../src/notifications/web-push";

// ============================================================================
// RFC 8291 aes128gcm framing + independent round-trip decryption
// ============================================================================

async function hkdfIndependent(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	lengthBytes: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		key,
		lengthBytes * 8,
	);
	return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/**
 * An INDEPENDENTLY written (not shared code with `web-push.ts`) client-side
 * decryptor for the `aes128gcm` content-coding, used to prove the
 * production encryptor is round-trip correct against RFC 8291/8188 -- not
 * merely self-consistent with its own helper functions.
 */
async function decryptAes128Gcm(params: {
	body: Uint8Array;
	receiverPrivateKey: CryptoKey;
	receiverPublicKeyBytes: Uint8Array;
	authSecret: Uint8Array;
}): Promise<Uint8Array> {
	const { body, receiverPrivateKey, receiverPublicKeyBytes, authSecret } =
		params;
	const salt = body.slice(0, 16);
	const recordSize = new DataView(
		body.buffer,
		body.byteOffset + 16,
		4,
	).getUint32(0, false);
	expect(recordSize).toBeGreaterThan(0);
	const idLen = body[20] as number;
	const keyId = body.slice(21, 21 + idLen);
	const ciphertext = body.slice(21 + idLen);

	const senderPublicKey = await crypto.subtle.importKey(
		"raw",
		keyId,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ecdhSecretBuffer = await crypto.subtle.deriveBits(
		{
			name: "ECDH",
			public: senderPublicKey,
			$public: senderPublicKey,
		} as unknown as SubtleCryptoDeriveKeyAlgorithm,
		receiverPrivateKey,
		256,
	);
	const ecdhSecret = new Uint8Array(ecdhSecretBuffer);

	const encoder = new TextEncoder();
	const keyInfo = concat(
		encoder.encode("WebPush: info\0"),
		receiverPublicKeyBytes,
		keyId,
	);
	const ikm = await hkdfIndependent(ecdhSecret, authSecret, keyInfo, 32);

	const cekBytes = await hkdfIndependent(
		ikm,
		salt,
		encoder.encode("Content-Encoding: aes128gcm\0"),
		16,
	);
	const nonce = await hkdfIndependent(
		ikm,
		salt,
		encoder.encode("Content-Encoding: nonce\0"),
		12,
	);

	const cek = await crypto.subtle.importKey(
		"raw",
		cekBytes,
		{ name: "AES-GCM" },
		false,
		["decrypt"],
	);
	const plaintextPaddedBuffer = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: nonce, tagLength: 128 },
		cek,
		ciphertext,
	);
	const plaintextPadded = new Uint8Array(plaintextPaddedBuffer);
	// Strip the RFC 8188 last-record delimiter (0x02) and any trailing padding.
	let end = plaintextPadded.length;
	while (end > 0 && plaintextPadded[end - 1] === 0x00) end--;
	expect(plaintextPadded[end - 1]).toBe(0x02);
	return plaintextPadded.slice(0, end - 1);
}

async function generateSubscriptionKeys(): Promise<{
	p256dh: string;
	auth: string;
	privateKey: CryptoKey;
	publicKeyBytes: Uint8Array;
	authBytes: Uint8Array;
}> {
	const keyPair = (await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	)) as CryptoKeyPair;
	const publicKeyBytes = new Uint8Array(
		(await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
	);
	const authBytes = crypto.getRandomValues(new Uint8Array(16));
	return {
		p256dh: encodeBase64Url(publicKeyBytes),
		auth: encodeBase64Url(authBytes),
		privateKey: keyPair.privateKey,
		publicKeyBytes,
		authBytes,
	};
}

describe("RFC 8291 aes128gcm encryption (Phase 15, Section 20/45)", () => {
	it("produces the correct binary header framing (salt(16)+rs(4)+idlen(1)+keyid(65))", async () => {
		const sub = await generateSubscriptionKeys();
		const plaintext = new TextEncoder().encode(
			JSON.stringify({ hello: "world" }),
		);
		const encrypted = await encryptWebPushPayload(
			{ p256dh: sub.p256dh, auth: sub.auth },
			plaintext,
		);
		expect(encrypted.body.length).toBeGreaterThan(21 + 65);
		expect(encrypted.salt.length).toBe(16);
		const idLen = encrypted.body[20];
		expect(idLen).toBe(65);
		const keyId = encrypted.body.slice(21, 21 + 65);
		expect(Array.from(keyId)).toEqual(Array.from(encrypted.serverPublicKey));
		expect(keyId[0]).toBe(0x04);
	});

	it("never leaks the plaintext substring anywhere in the encrypted body", async () => {
		const sub = await generateSubscriptionKeys();
		const secretMarker = "SUPER-SECRET-NOTIFICATION-BODY-MARKER";
		const plaintext = new TextEncoder().encode(
			JSON.stringify({ body: secretMarker }),
		);
		const encrypted = await encryptWebPushPayload(
			{ p256dh: sub.p256dh, auth: sub.auth },
			plaintext,
		);
		const bodyAsLatin1 = Array.from(encrypted.body)
			.map((b) => String.fromCharCode(b))
			.join("");
		expect(bodyAsLatin1).not.toContain(secretMarker);
		expect(Array.from(encrypted.body)).not.toEqual(Array.from(plaintext));
	});

	it("round-trips: an independent client-side decryptor recovers the exact plaintext", async () => {
		const sub = await generateSubscriptionKeys();
		const original = { type: "CREDIT_CARD_DUE", statementId: "abc-123" };
		const plaintext = new TextEncoder().encode(JSON.stringify(original));

		const encrypted = await encryptWebPushPayload(
			{ p256dh: sub.p256dh, auth: sub.auth },
			plaintext,
		);

		const decrypted = await decryptAes128Gcm({
			body: encrypted.body,
			receiverPrivateKey: sub.privateKey,
			receiverPublicKeyBytes: sub.publicKeyBytes,
			authSecret: sub.authBytes,
		});

		expect(new TextDecoder().decode(decrypted)).toBe(JSON.stringify(original));
	});

	it("produces a different ciphertext (fresh salt/ephemeral key) for repeated encryptions of the same plaintext", async () => {
		const sub = await generateSubscriptionKeys();
		const plaintext = new TextEncoder().encode(JSON.stringify({ a: 1 }));
		const first = await encryptWebPushPayload(
			{ p256dh: sub.p256dh, auth: sub.auth },
			plaintext,
		);
		const second = await encryptWebPushPayload(
			{ p256dh: sub.p256dh, auth: sub.auth },
			plaintext,
		);
		expect(Array.from(first.body)).not.toEqual(Array.from(second.body));
	});

	it("rejects a malformed p256dh", async () => {
		await expect(
			encryptWebPushPayload(
				{
					p256dh: "not-valid-base64url!!!",
					auth: encodeBase64Url(new Uint8Array(16)),
				},
				new Uint8Array([1, 2, 3]),
			),
		).rejects.toMatchObject({ code: "NOTIFICATION_INVALID_INPUT" });
	});
});

// ============================================================================
// RFC 8292 VAPID
// ============================================================================

async function generateVapidKeys(): Promise<{
	publicKey: string;
	privateKey: string;
	verifyKey: CryptoKey;
}> {
	const keyPair = (await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const publicKeyBytes = new Uint8Array(
		(await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
	);
	const jwk = (await crypto.subtle.exportKey(
		"jwk",
		keyPair.privateKey,
	)) as JsonWebKey;
	return {
		publicKey: encodeBase64Url(publicKeyBytes),
		privateKey: jwk.d as string,
		verifyKey: keyPair.publicKey,
	};
}

describe("RFC 8292 VAPID header construction (Phase 15, Section 20/45)", () => {
	it("builds a structurally valid ES256 JWT and vapid Authorization header", async () => {
		const vapid = await generateVapidKeys();
		const headers = await buildVapidHeaders({
			audience: "https://fcm.example.test",
			subject: "mailto:test@example.test",
			publicKey: vapid.publicKey,
			privateKey: vapid.privateKey,
			nowSeconds: 1_700_000_000,
		});

		expect(headers.authorization).toMatch(/^vapid t=.+, k=.+$/);
		expect(headers.authorization).toContain(`k=${vapid.publicKey}`);

		const parts = headers.jwt.split(".");
		expect(parts).toHaveLength(3);

		const header = JSON.parse(
			new TextDecoder().decode(decodeBase64Url(parts[0] as string, "header")),
		);
		expect(header).toEqual({ typ: "JWT", alg: "ES256" });

		const claims = JSON.parse(
			new TextDecoder().decode(decodeBase64Url(parts[1] as string, "claims")),
		);
		expect(claims.aud).toBe("https://fcm.example.test");
		expect(claims.sub).toBe("mailto:test@example.test");
		expect(claims.exp).toBeGreaterThan(1_700_000_000);

		// Independently verify the signature with the public key -- proves the
		// JWT is not merely self-consistent but actually a valid ES256
		// signature over header.claims.
		const signatureBytes = decodeBase64Url(parts[2] as string, "signature");
		const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
		const valid = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			vapid.verifyKey,
			signatureBytes,
			signedData,
		);
		expect(valid).toBe(true);
	});

	it("rejects a malformed VAPID private key", async () => {
		await expect(
			buildVapidHeaders({
				audience: "https://fcm.example.test",
				subject: "mailto:test@example.test",
				publicKey: encodeBase64Url(
					(() => {
						const b = new Uint8Array(65);
						b[0] = 0x04;
						return b;
					})(),
				),
				privateKey: "not-valid-base64url!!!",
			}),
		).rejects.toMatchObject({ code: "NOTIFICATION_PUSH_CONFIG_INVALID" });
	});
});

// ============================================================================
// Push response classification (Section 23)
// ============================================================================

describe("classifyPushResponseStatus (Section 23)", () => {
	it.each([
		[200, "SUCCESS"],
		[201, "SUCCESS"],
		[404, "TERMINAL_FAILURE"],
		[410, "TERMINAL_FAILURE"],
		[429, "RETRYABLE_FAILURE"],
		[500, "RETRYABLE_FAILURE"],
		[503, "RETRYABLE_FAILURE"],
		[400, "TERMINAL_FAILURE"],
	])("classifies HTTP %i as %s", (status, outcome) => {
		expect(classifyPushResponseStatus(status).outcome).toBe(outcome);
	});

	it("classifies 404/410 with an ENDPOINT_GONE error code", () => {
		expect(classifyPushResponseStatus(404).errorCode).toBe("ENDPOINT_GONE");
		expect(classifyPushResponseStatus(410).errorCode).toBe("ENDPOINT_GONE");
	});

	it("classifies 401/403 as a config-invalid terminal failure", () => {
		expect(classifyPushResponseStatus(401)).toMatchObject({
			outcome: "TERMINAL_FAILURE",
			errorCode: "NOTIFICATION_PUSH_CONFIG_INVALID",
		});
	});

	it("classifies a null status (network error) as retryable", () => {
		expect(classifyPushResponseStatus(null)).toMatchObject({
			outcome: "RETRYABLE_FAILURE",
			errorCode: "NETWORK_ERROR",
		});
	});
});

// ============================================================================
// WebPushTransport.send -- headers, no real network, no plaintext leak
// ============================================================================

describe("WebPushTransport.send (Section 20/22/33/45, mocked fetch only)", () => {
	it("sets the required headers and never issues a real network call", async () => {
		const sub = await generateSubscriptionKeys();
		const vapid = await generateVapidKeys();
		const env: AppEnv = {
			WEB_PUSH_VAPID_SUBJECT: "mailto:test@example.test",
			WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
			WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
		};

		let capturedRequest: { url: string; init: RequestInit } | null = null;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					capturedRequest = { url: String(input), init: init ?? {} };
					return new Response(null, { status: 201 });
				},
			);

		try {
			const transport = new WebPushTransport(env);
			const secretMarker = "TOP-SECRET-BODY";
			const payload = { title: "t", body: secretMarker };
			const result = await transport.send(
				{
					endpoint: "https://fcm.example.test/synthetic/xyz",
					p256dh: sub.p256dh,
					auth: sub.auth,
				},
				payload,
				{ ttlSeconds: 3600 },
			);

			expect(result.outcome).toBe("SUCCESS");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(capturedRequest).not.toBeNull();
			const req = capturedRequest as unknown as {
				url: string;
				init: RequestInit;
			};

			const headers = req.init.headers as Record<string, string>;
			expect(headers["Content-Encoding"]).toBe("aes128gcm");
			expect(headers["Content-Type"]).toBe("application/octet-stream");
			expect(headers.TTL).toBe("3600");
			expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);

			const rawBody = req.init.body as Uint8Array;
			const bodyAsLatin1 = Array.from(rawBody)
				.map((b) => String.fromCharCode(b))
				.join("");
			expect(bodyAsLatin1).not.toContain(secretMarker);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("classifies a network failure as RETRYABLE_FAILURE without throwing", async () => {
		const sub = await generateSubscriptionKeys();
		const vapid = await generateVapidKeys();
		const env: AppEnv = {
			WEB_PUSH_VAPID_SUBJECT: "mailto:test@example.test",
			WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
			WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("network down"));
		try {
			const transport = new WebPushTransport(env);
			const result = await transport.send(
				{
					endpoint: "https://fcm.example.test/synthetic/xyz",
					p256dh: sub.p256dh,
					auth: sub.auth,
				},
				{ title: "t" },
				{ ttlSeconds: 60 },
			);
			expect(result).toMatchObject({
				outcome: "RETRYABLE_FAILURE",
				errorCode: "NETWORK_ERROR",
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("throws a sanitized NOTIFICATION_PUSH_CONFIG_INVALID error when VAPID env is missing", async () => {
		const sub = await generateSubscriptionKeys();
		const transport = new WebPushTransport({});
		await expect(
			transport.send(
				{
					endpoint: "https://fcm.example.test/synthetic/xyz",
					p256dh: sub.p256dh,
					auth: sub.auth,
				},
				{ title: "t" },
				{ ttlSeconds: 60 },
			),
		).rejects.toMatchObject({ code: "NOTIFICATION_PUSH_CONFIG_INVALID" });
	});
});

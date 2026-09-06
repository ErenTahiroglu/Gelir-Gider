import type { AppEnv } from "../config/env";
import { getWebPushVapidConfig } from "../config/env";
import { decodeBase64Url, encodeBase64Url } from "./calendar";
import { NotificationError } from "./errors";

/**
 * Real, standards-compliant Web Push production transport, implemented
 * directly against WebCrypto (`crypto.subtle`) + `fetch` -- no Node-only
 * APIs, so it runs unmodified inside Cloudflare Workers (`workerd`).
 * Implements RFC 8292 (VAPID) and RFC 8291 (`aes128gcm` message encryption).
 */

export interface PushSendResult {
	outcome: "SUCCESS" | "RETRYABLE_FAILURE" | "TERMINAL_FAILURE";
	httpStatus?: number;
	errorCode?: string;
}

export interface PushSubscriptionKeys {
	endpoint: string;
	p256dh: string;
	auth: string;
}

export interface PushSendOptions {
	ttlSeconds: number;
	urgency?: "very-low" | "low" | "normal" | "high" | undefined;
}

/**
 * Testable transport abstraction. `runNotificationScheduler` accepts an
 * injected `transport` so DB-less tests can supply a fake implementation
 * (no internet, no real browser endpoint).
 */
export interface PushTransport {
	send(
		subscription: PushSubscriptionKeys,
		payload: object,
		options: PushSendOptions,
	): Promise<PushSendResult>;
}

/**
 * Classifies a raw push-service HTTP response (or network failure) into a
 * sanitized `PushSendResult`. Pure and DB-less testable (Section 23).
 */
export function classifyPushResponseStatus(
	httpStatus: number | null,
): PushSendResult {
	if (httpStatus === null) {
		return { outcome: "RETRYABLE_FAILURE", errorCode: "NETWORK_ERROR" };
	}
	if (httpStatus >= 200 && httpStatus < 300) {
		return { outcome: "SUCCESS", httpStatus };
	}
	if (httpStatus === 404 || httpStatus === 410) {
		return {
			outcome: "TERMINAL_FAILURE",
			httpStatus,
			errorCode: "ENDPOINT_GONE",
		};
	}
	if (httpStatus === 429) {
		return {
			outcome: "RETRYABLE_FAILURE",
			httpStatus,
			errorCode: "RATE_LIMITED",
		};
	}
	if (httpStatus === 401 || httpStatus === 403) {
		return {
			outcome: "TERMINAL_FAILURE",
			httpStatus,
			errorCode: "NOTIFICATION_PUSH_CONFIG_INVALID",
		};
	}
	if (httpStatus >= 500) {
		return {
			outcome: "RETRYABLE_FAILURE",
			httpStatus,
			errorCode: "PUSH_SERVICE_ERROR",
		};
	}
	return {
		outcome: "TERMINAL_FAILURE",
		httpStatus,
		errorCode: "PUSH_REJECTED",
	};
}

// ============================================================================
// RFC 8292 -- VAPID
// ============================================================================

const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

function toJwkCoordinates(publicKeyBytes: Uint8Array): {
	x: string;
	y: string;
} {
	if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
		throw new NotificationError(
			"NOTIFICATION_PUSH_CONFIG_INVALID",
			"VAPID public key is not a valid uncompressed P-256 point",
		);
	}
	return {
		x: encodeBase64Url(publicKeyBytes.slice(1, 33)),
		y: encodeBase64Url(publicKeyBytes.slice(33, 65)),
	};
}

async function importVapidPrivateKey(
	privateKeyB64Url: string,
	publicKeyB64Url: string,
): Promise<CryptoKey> {
	let privateBytes: Uint8Array;
	let publicBytes: Uint8Array;
	try {
		privateBytes = decodeBase64Url(privateKeyB64Url, "vapidPrivateKey");
		publicBytes = decodeBase64Url(publicKeyB64Url, "vapidPublicKey");
	} catch {
		throw new NotificationError(
			"NOTIFICATION_PUSH_CONFIG_INVALID",
			"VAPID key material is not valid base64url",
		);
	}
	if (privateBytes.length !== 32) {
		throw new NotificationError(
			"NOTIFICATION_PUSH_CONFIG_INVALID",
			"VAPID private key must be a 32-byte P-256 scalar",
		);
	}
	const { x, y } = toJwkCoordinates(publicBytes);
	const jwk: JsonWebKey = {
		kty: "EC",
		crv: "P-256",
		d: encodeBase64Url(privateBytes),
		x,
		y,
		ext: true,
	};
	try {
		return await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["sign"],
		);
	} catch {
		throw new NotificationError(
			"NOTIFICATION_PUSH_CONFIG_INVALID",
			"VAPID private key could not be imported as a P-256 signing key",
		);
	}
}

export interface VapidHeaders {
	authorization: string;
	jwt: string;
}

/**
 * Builds the RFC 8292 VAPID `Authorization: vapid t=<jwt>, k=<publicKey>`
 * header for a given push service origin (`aud`).
 */
export async function buildVapidHeaders(params: {
	audience: string;
	subject: string;
	publicKey: string;
	privateKey: string;
	nowSeconds?: number;
}): Promise<VapidHeaders> {
	const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
	const header = { typ: "JWT", alg: "ES256" };
	const claims = {
		aud: params.audience,
		exp: now + VAPID_TOKEN_TTL_SECONDS,
		sub: params.subject,
	};
	const encoder = new TextEncoder();
	const headerB64 = encodeBase64Url(encoder.encode(JSON.stringify(header)));
	const claimsB64 = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
	const unsigned = `${headerB64}.${claimsB64}`;

	const signingKey = await importVapidPrivateKey(
		params.privateKey,
		params.publicKey,
	);
	const signatureBuffer = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		signingKey,
		encoder.encode(unsigned),
	);
	// WebCrypto ECDSA signatures are already raw (r||s, IEEE P1363) -- the
	// exact format JWS ES256 requires, no DER conversion needed.
	const signatureB64 = encodeBase64Url(new Uint8Array(signatureBuffer));
	const jwt = `${unsigned}.${signatureB64}`;

	return {
		jwt,
		authorization: `vapid t=${jwt}, k=${params.publicKey}`,
	};
}

// ============================================================================
// RFC 8291 -- aes128gcm message encryption
// ============================================================================

async function hkdf(
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

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

export interface EncryptedWebPushMessage {
	body: Uint8Array;
	salt: Uint8Array;
	serverPublicKey: Uint8Array;
}

/**
 * Encrypts `plaintext` per RFC 8291 (`aes128gcm` content-encoding, RFC 8188
 * binary header framing: salt(16) + record-size(4) + keyid-length(1) +
 * keyid(65) + ciphertext).
 */
export async function encryptWebPushPayload(
	subscription: { p256dh: string; auth: string },
	plaintext: Uint8Array,
): Promise<EncryptedWebPushMessage> {
	const userPublicKeyBytes = decodeBase64Url(subscription.p256dh, "p256dh");
	const authSecret = decodeBase64Url(subscription.auth, "auth");
	if (userPublicKeyBytes.length !== 65 || userPublicKeyBytes[0] !== 0x04) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"p256dh must decode to a 65-byte uncompressed P-256 public key",
		);
	}
	if (authSecret.length !== 16) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_INPUT",
			"auth must decode to exactly 16 bytes",
		);
	}

	const userPublicKey = await crypto.subtle.importKey(
		"raw",
		userPublicKeyBytes,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);

	const ephemeralKeyPair = (await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	)) as CryptoKeyPair;

	const ephemeralPublicKeyBytes = new Uint8Array(
		(await crypto.subtle.exportKey(
			"raw",
			ephemeralKeyPair.publicKey,
		)) as ArrayBuffer,
	);

	// The standard Web Crypto ECDH deriveBits algorithm dict names this field
	// `public`; Cloudflare's generated Workers types alias it as `$public`
	// (a codegen artifact). Both are set so this works regardless of which
	// name the running workerd binding actually reads.
	const ecdhSecretBuffer = await crypto.subtle.deriveBits(
		{
			name: "ECDH",
			public: userPublicKey,
			$public: userPublicKey,
		} as unknown as SubtleCryptoDeriveKeyAlgorithm,
		ephemeralKeyPair.privateKey,
		256,
	);
	const ecdhSecret = new Uint8Array(ecdhSecretBuffer);

	const encoder = new TextEncoder();
	const keyInfo = concatBytes(
		encoder.encode("WebPush: info\0"),
		userPublicKeyBytes,
		ephemeralPublicKeyBytes,
	);
	// Stage 1: derive the per-subscription IKM, salted by the subscription's
	// long-lived auth secret.
	const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

	// Stage 2: derive the per-message content-encryption key and nonce,
	// salted by a fresh random 16-byte salt.
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cekInfo = encoder.encode("Content-Encoding: aes128gcm\0");
	const nonceInfo = encoder.encode("Content-Encoding: nonce\0");
	const cekBytes = await hkdf(ikm, salt, cekInfo, 16);
	const nonce = await hkdf(ikm, salt, nonceInfo, 12);

	const cek = await crypto.subtle.importKey(
		"raw",
		cekBytes,
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);

	// Single-record message: append the RFC 8188 last-record delimiter
	// (0x02); no additional padding is needed for this fixed-shape payload.
	const paddedPlaintext = concatBytes(plaintext, new Uint8Array([0x02]));
	const ciphertextBuffer = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, tagLength: 128 },
		cek,
		paddedPlaintext,
	);
	const ciphertext = new Uint8Array(ciphertextBuffer);

	const recordSize = 4096;
	const header = new Uint8Array(16 + 4 + 1 + 65);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, recordSize, false);
	header[20] = 65;
	header.set(ephemeralPublicKeyBytes, 21);

	return {
		body: concatBytes(header, ciphertext),
		salt,
		serverPublicKey: ephemeralPublicKeyBytes,
	};
}

// ============================================================================
// Production transport
// ============================================================================

function pushServiceOrigin(endpoint: string): string {
	const url = new URL(endpoint);
	return `${url.protocol}//${url.host}`;
}

/**
 * Production Web Push transport. VAPID configuration is validated LAZILY --
 * only when `send()` is actually invoked -- never at construction/module
 * load time (Section 22).
 */
export class WebPushTransport implements PushTransport {
	private readonly env: AppEnv;

	constructor(env: AppEnv) {
		this.env = env;
	}

	async send(
		subscription: PushSubscriptionKeys,
		payload: object,
		options: PushSendOptions,
	): Promise<PushSendResult> {
		let vapid: ReturnType<typeof getWebPushVapidConfig>;
		try {
			vapid = getWebPushVapidConfig(this.env);
		} catch {
			throw new NotificationError(
				"NOTIFICATION_PUSH_CONFIG_INVALID",
				"Web Push VAPID configuration is missing or invalid",
			);
		}

		const plaintext = new TextEncoder().encode(JSON.stringify(payload));
		const encrypted = await encryptWebPushPayload(subscription, plaintext);
		const vapidHeaders = await buildVapidHeaders({
			audience: pushServiceOrigin(subscription.endpoint),
			subject: vapid.subject,
			publicKey: vapid.publicKey,
			privateKey: vapid.privateKey,
		});

		let response: Response;
		try {
			response = await fetch(subscription.endpoint, {
				method: "POST",
				headers: {
					"Content-Encoding": "aes128gcm",
					"Content-Type": "application/octet-stream",
					TTL: String(options.ttlSeconds),
					Authorization: vapidHeaders.authorization,
					...(options.urgency ? { Urgency: options.urgency } : {}),
				},
				body: encrypted.body,
			});
		} catch {
			// Network/timeout error -- never leak endpoint details.
			return { outcome: "RETRYABLE_FAILURE", errorCode: "NETWORK_ERROR" };
		}

		// Drain the body without ever persisting or logging it.
		try {
			await response.arrayBuffer();
		} catch {
			// ignore
		}

		return classifyPushResponseStatus(response.status);
	}
}

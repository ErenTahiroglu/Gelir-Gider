/**
 * Web Push Utilities & Client-Side Crypto Helpers (Phase F9).
 *
 * Implements base64url encoding/decoding, browser feature detection,
 * service worker registration with /push/ scope, and subscription serialization.
 */

export const LOCAL_PUSH_SUBSCRIPTION_KEY = "gelir-gider.pushSubscriptionId";

export function getLocalSubscriptionId(): string | null {
	try {
		return localStorage.getItem(LOCAL_PUSH_SUBSCRIPTION_KEY);
	} catch {
		return null;
	}
}

export function setLocalSubscriptionId(id: string): void {
	try {
		localStorage.setItem(LOCAL_PUSH_SUBSCRIPTION_KEY, id);
	} catch {
		// Ignore storage errors in restricted contexts
	}
}

export function clearLocalSubscriptionId(): void {
	try {
		localStorage.removeItem(LOCAL_PUSH_SUBSCRIPTION_KEY);
	} catch {
		// Ignore
	}
}

/**
 * Checks if the current browser and context support Web Push notifications.
 */
export function isPushSupported(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	return (
		window.isSecureContext &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	);
}

/**
 * Converts a base64url or standard base64 string to a Uint8Array.
 * Used for applicationServerKey in pushManager.subscribe().
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

	const rawData = window.atob(base64);
	const outputArray = new Uint8Array(rawData.length);

	for (let i = 0; i < rawData.length; ++i) {
		outputArray[i] = rawData.charCodeAt(i);
	}
	return outputArray;
}

/**
 * Converts an ArrayBuffer to an unpadded base64url string.
 * Used for serializing p256dh and auth keys matching backend format.
 */
export function arrayBufferToBase64Url(
	buffer: ArrayBuffer | null | undefined,
): string {
	if (!buffer || buffer.byteLength === 0) {
		return "";
	}
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		const b = bytes[i];
		if (b !== undefined) {
			binary += String.fromCharCode(b);
		}
	}
	const base64 = window.btoa(binary);
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const getStoredPushSubscriptionId = getLocalSubscriptionId;
export const setStoredPushSubscriptionId = setLocalSubscriptionId;
export const removeStoredPushSubscriptionId = clearLocalSubscriptionId;

const PUSH_SCOPE_PATH = "/push/";
const PUSH_ACTIVATION_TIMEOUT_MS = 10_000;

/**
 * Finds ONLY the registration whose scope pathname is exactly /push/.
 * getRegistration("/push/") is unsafe: it also matches the root "/" PWA scope.
 */
export async function findPushRegistration(): Promise<
	ServiceWorkerRegistration | undefined
> {
	const regs = await navigator.serviceWorker.getRegistrations();
	return regs.find((r) => {
		try {
			const u = new URL(r.scope, window.location.href);
			return (
				u.origin === window.location.origin && u.pathname === PUSH_SCOPE_PATH
			);
		} catch {
			return false;
		}
	});
}

/**
 * Bounded wait until the target registration has an activated worker.
 * Never uses navigator.serviceWorker.ready (it resolves the root registration).
 */
export function waitForActivatedWorker(
	reg: ServiceWorkerRegistration,
	timeoutMs: number = PUSH_ACTIVATION_TIMEOUT_MS,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const watched = new Set<ServiceWorker>();
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const w of watched) w.removeEventListener("statechange", check);
			if (err) reject(err);
			else resolve();
		};
		const timer = setTimeout(() => {
			const e = new Error("Push service worker activation timed out");
			e.name = "PushActivationTimeout";
			finish(e);
		}, timeoutMs);
		function check() {
			if (reg.active?.state === "activated") return finish();
			const w = reg.installing ?? reg.waiting ?? reg.active;
			if (!w) return;
			if (w.state === "redundant") {
				const e = new Error("Push service worker became redundant");
				e.name = "PushActivationFailed";
				return finish(e);
			}
			if (w.state === "activated") return finish();
			if (!watched.has(w)) {
				watched.add(w);
				w.addEventListener("statechange", check);
			}
		}
		check();
	});
}

/**
 * Returns the dedicated, ACTIVATED push-only registration under exact /push/ scope.
 */
export async function getOrRegisterPushServiceWorker(): Promise<ServiceWorkerRegistration> {
	if (!isPushSupported()) {
		throw new Error("Web Push is not supported in this browser");
	}

	const reg =
		(await findPushRegistration()) ??
		(await navigator.serviceWorker.register("/push-sw.js", {
			scope: PUSH_SCOPE_PATH,
		}));

	if (new URL(reg.scope, window.location.href).pathname !== PUSH_SCOPE_PATH) {
		const e = new Error("Push service worker scope mismatch");
		e.name = "PushScopeMismatch";
		throw e;
	}

	await waitForActivatedWorker(reg);
	return reg;
}

/**
 * Safe diagnostic name only (never the error object/message: may carry key material).
 */
export function safeErrorName(err: unknown): string {
	const n = (err as { name?: unknown } | null)?.name;
	return typeof n === "string" && /^[A-Za-z]{1,40}$/.test(n)
		? n
		: "UnknownError";
}

/**
 * Serializes a browser PushSubscription into backend-compatible format.
 */
export function serializeBrowserPushSubscription(
	subscription: PushSubscription,
	occurredAt: string = new Date().toISOString(),
): {
	endpoint: string;
	p256dh: string;
	auth: string;
	expirationTime: string | null;
	userAgent: string | null;
	occurredAt: string;
} {
	const p256dhBuffer = subscription.getKey("p256dh");
	const authBuffer = subscription.getKey("auth");

	const p256dh = arrayBufferToBase64Url(p256dhBuffer);
	const auth = arrayBufferToBase64Url(authBuffer);

	const expirationTime =
		subscription.expirationTime !== null &&
		subscription.expirationTime !== undefined
			? new Date(subscription.expirationTime).toISOString()
			: null;

	const userAgent =
		typeof navigator !== "undefined" ? navigator.userAgent : null;

	return {
		endpoint: subscription.endpoint,
		p256dh,
		auth,
		expirationTime,
		userAgent,
		occurredAt,
	};
}

/**
 * Validates and sanitizes deep links to ensure strict same-origin relative paths.
 * Rejects external URLs, protocol-relative '//', and invalid patterns.
 */
export function sanitizeDeepLink(raw: unknown): string {
	if (typeof raw !== "string") return "/";
	const trimmed = raw.trim();
	if (
		!trimmed.startsWith("/") ||
		trimmed.startsWith("//") ||
		trimmed.includes("\\")
	) {
		return "/";
	}
	try {
		const baseOrigin =
			typeof window !== "undefined" && window.location?.origin
				? window.location.origin
				: typeof self !== "undefined" && self.location?.origin
					? self.location.origin
					: "http://localhost";
		const resolved = new URL(trimmed, baseOrigin);
		if (resolved.origin !== baseOrigin) {
			return "/";
		}
		return `${resolved.pathname}${resolved.search}${resolved.hash}`;
	} catch {
		return "/";
	}
}

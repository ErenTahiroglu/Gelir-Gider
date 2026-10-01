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

/**
 * Registers or retrieves the dedicated push-only service worker registered under /push/ scope.
 */
export async function getOrRegisterPushServiceWorker(): Promise<ServiceWorkerRegistration> {
	if (!isPushSupported()) {
		throw new Error("Web Push is not supported in this browser");
	}

	// First check if already registered
	const existing = await navigator.serviceWorker.getRegistration("/push/");
	if (existing) {
		return existing;
	}

	return await navigator.serviceWorker.register("/push-sw.js", {
		scope: "/push/",
	});
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

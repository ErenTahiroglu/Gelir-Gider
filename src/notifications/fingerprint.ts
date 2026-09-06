async function sha256Hex(data: unknown[]): Promise<string> {
	const serialized = JSON.stringify(data, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PushSubscriptionRegisterFingerprintParams {
	userId: string;
	endpointHash: string;
	operation: "REGISTER" | "REFRESH" | "REACTIVATE";
	endpoint: string;
	p256dh: string;
	auth: string;
	expirationTime: Date | null;
	userAgent: string | null;
	occurredAt: Date;
}

export async function calculatePushSubscriptionRegisterFingerprint(
	params: PushSubscriptionRegisterFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"push-subscription-revision-v1",
		params.userId.trim().toLowerCase(),
		params.endpointHash,
		params.operation,
		params.endpoint,
		params.p256dh,
		params.auth,
		params.expirationTime ? params.expirationTime.toISOString() : null,
		params.userAgent,
		params.occurredAt.toISOString(),
	]);
}

export interface PushSubscriptionDisableFingerprintParams {
	userId: string;
	subscriptionId: string;
	expectedRevisionNo: number;
	disableReason: string | null;
	occurredAt: Date;
}

export async function calculatePushSubscriptionDisableFingerprint(
	params: PushSubscriptionDisableFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"push-subscription-revision-v1",
		params.userId.trim().toLowerCase(),
		params.subscriptionId.trim().toLowerCase(),
		"DISABLE",
		params.expectedRevisionNo,
		params.disableReason,
		params.occurredAt.toISOString(),
	]);
}

/**
 * Derives a bounded (64-char hex) child idempotency key from a parent key
 * plus identity/operation context. Mirrors
 * `long-term/fingerprint.ts::deriveLongTermChildIdempotencyKey` /
 * `month-close/fingerprint.ts::deriveMonthCloseChildIdempotencyKey` -- never
 * concatenates an arbitrary caller-supplied key directly into another
 * bounded DB column.
 */
export async function deriveNotificationChildIdempotencyKey(
	parentKey: string,
	parts: string[],
): Promise<string> {
	return sha256Hex(["notification-child-idempotency-v1", parentKey, ...parts]);
}

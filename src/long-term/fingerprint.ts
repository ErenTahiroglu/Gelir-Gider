async function sha256Hex(data: unknown[]): Promise<string> {
	const serialized = JSON.stringify(data, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface LongTermTaskCreateFingerprintParams {
	userId: string;
	midasAccountId: string;
	amount: string;
	destinationLabel: string | null;
	note: string | null;
	occurredAt: Date;
}

export async function calculateLongTermTaskCreateFingerprint(
	params: LongTermTaskCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"long-term-task-revision-v1",
		params.userId.trim().toLowerCase(),
		params.midasAccountId.trim().toLowerCase(),
		"CREATE",
		params.amount,
		params.destinationLabel,
		params.note,
		params.occurredAt.toISOString(),
	]);
}

export interface LongTermTaskLifecycleFingerprintParams {
	userId: string;
	taskId: string;
	operation: "SENT" | "REOPEN" | "CANCEL";
	expectedRevisionNo: number;
	occurredAt: Date;
	reasonNote: string | null;
}

export async function calculateLongTermTaskLifecycleFingerprint(
	params: LongTermTaskLifecycleFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"long-term-task-revision-v1",
		params.userId.trim().toLowerCase(),
		params.taskId.trim().toLowerCase(),
		params.operation,
		params.expectedRevisionNo,
		params.occurredAt.toISOString(),
		params.reasonNote,
	]);
}

/**
 * Derives a bounded (64-char hex) child idempotency key from a parent
 * caller-supplied key plus identity/operation context (e.g. parent key,
 * taskId, revision operation, relevant identity). Never concatenates an
 * arbitrary 128-char caller key directly into another 128-char DB column --
 * always hashes down to a fixed, safe length.
 */
export async function deriveLongTermChildIdempotencyKey(
	parentKey: string,
	parts: string[],
): Promise<string> {
	return sha256Hex(["long-term-child-idempotency-v1", parentKey, ...parts]);
}

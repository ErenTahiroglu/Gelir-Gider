export interface CalculateAllocationTransferFingerprintParams {
	userId: string;
	midasAccountId: string;
	fromBucketId: string | null;
	toBucketId: string | null;
	amount: string; // Exact normalized decimal string
	occurredAt: Date;
	memo: string | null;
	reversalOfTransferId: string | null;
}

/**
 * Calculates a deterministic 64 lowercase hex SHA-256 fingerprint for a Midas allocation transfer
 * using structured canonical array serialization and standard Web Crypto API.
 */
export async function calculateAllocationTransferFingerprint(
	params: CalculateAllocationTransferFingerprintParams,
): Promise<string> {
	const canonicalTuple = [
		"midas-allocation-transfer-v1",
		params.userId,
		params.midasAccountId,
		params.fromBucketId,
		params.toBucketId,
		params.amount,
		params.occurredAt.toISOString(),
		params.memo,
		params.reversalOfTransferId,
	];

	const serialized = JSON.stringify(canonicalTuple);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

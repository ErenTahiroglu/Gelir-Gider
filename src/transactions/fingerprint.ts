import { stringifyCanonicalJson } from "./canonical-json";

export interface NormalizedSourceDescriptor {
	type: string;
	ref: string | null;
	payloadHash: string | null;
	observedAt: string | null;
}

export interface CalculateRevisionFingerprintParams {
	operation: "CREATE" | "UPDATE" | "VOID";
	userId: string;
	transactionId?: string | null;
	kind: string;
	occurredAt: Date;
	payload: Record<string, unknown>;
	reasonCode?: string | null;
	reasonNote?: string | null;
	source: NormalizedSourceDescriptor;
}

/**
 * Calculates a deterministic 64 lowercase hex SHA-256 revision fingerprint
 * using a versioned structured tuple array.
 */
export async function calculateRevisionFingerprint(
	params: CalculateRevisionFingerprintParams,
): Promise<string> {
	const sourceTuple = [
		params.source.type,
		params.source.ref,
		params.source.payloadHash,
		params.source.observedAt,
	];

	const canonicalPayloadString = stringifyCanonicalJson(params.payload);
	const canonicalPayloadObject = JSON.parse(canonicalPayloadString);

	let canonicalTuple: unknown[];

	if (params.operation === "CREATE") {
		canonicalTuple = [
			"canonical-transaction-revision-v1",
			"CREATE",
			params.userId,
			params.kind,
			params.occurredAt.toISOString(),
			canonicalPayloadObject,
			null,
			null,
			sourceTuple,
		];
	} else if (params.operation === "UPDATE") {
		canonicalTuple = [
			"canonical-transaction-revision-v1",
			"UPDATE",
			params.userId,
			params.transactionId ?? null,
			params.kind,
			params.occurredAt.toISOString(),
			canonicalPayloadObject,
			params.reasonCode ?? null,
			params.reasonNote ?? null,
			sourceTuple,
		];
	} else {
		canonicalTuple = [
			"canonical-transaction-revision-v1",
			"VOID",
			params.userId,
			params.transactionId ?? null,
			params.kind,
			params.occurredAt.toISOString(),
			canonicalPayloadObject,
			params.reasonCode ?? null,
			params.reasonNote ?? null,
			sourceTuple,
		];
	}

	const serialized = JSON.stringify(canonicalTuple);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

import { BudgetError } from "./errors";

/**
 * Canonical deterministic JSON serialization for a Budget V2 checkpoint report.
 *
 * - object keys are sorted recursively (lexicographic, by code unit)
 * - arrays retain their semantic order
 * - primitives are emitted exactly as `JSON.stringify` would (all money is
 *   already a decimal string in the report -- there is no float money to
 *   convert, and this function refuses any non-finite number defensively)
 * - `undefined` object properties are dropped (they are dropped by
 *   `JSON.stringify` too); `undefined` inside an array becomes `null`
 *
 * The result is stable regardless of the key insertion order of the input
 * object, so a JSONB round-trip (which does not preserve key order) hashes
 * identically to the in-memory report.
 */
export function canonicalJsonStringify(value: unknown): string {
	return serialize(value);
}

function serialize(value: unknown): string {
	if (value === null) return "null";
	const t = typeof value;
	if (t === "string") return JSON.stringify(value);
	if (t === "boolean") return value ? "true" : "false";
	if (t === "number") {
		if (!Number.isFinite(value as number)) {
			throw new BudgetError(
				"BUDGET_CHECKPOINT_REPORT_FAIL_CLOSED",
				"checkpoint report contains a non-finite number; refusing to serialize",
			);
		}
		return JSON.stringify(value);
	}
	if (t === "bigint") {
		throw new BudgetError(
			"BUDGET_CHECKPOINT_REPORT_FAIL_CLOSED",
			"checkpoint report contains a bigint; money must be a decimal string",
		);
	}
	if (t === "undefined" || t === "function" || t === "symbol") {
		// Only reachable for a top-level / array element; object props are
		// filtered before recursion.
		return "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => serialize(v)).join(",")}]`;
	}
	// plain object
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
	return `{${parts.join(",")}}`;
}

async function sha256HexOfString(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Lowercase SHA-256 of the canonical serialization of a checkpoint report.
 */
export function calculateCheckpointReportFingerprint(
	report: unknown,
): Promise<string> {
	return sha256HexOfString(canonicalJsonStringify(report));
}

export interface StoredCheckpointSnapshotRow {
	reportSchemaVersion: string;
	reportJson: unknown;
	reportFingerprint: string;
	paymentEventId: string;
	periodMonth: string;
	checkpointAt: Date;
	previousCheckpointAt: Date | null;
}

/**
 * Re-derives and verifies the integrity of a stored checkpoint snapshot before
 * it is handed back as a historical replay. Any divergence between the frozen
 * `report_json` and the stored identity columns / recomputed fingerprint is a
 * typed corruption error -- never a silently "repaired" read.
 */
export async function verifyStoredCheckpointSnapshot(
	row: StoredCheckpointSnapshotRow,
): Promise<void> {
	const report = row.reportJson as
		| {
				schemaVersion?: unknown;
				checkpoint?: {
					schemaVersion?: unknown;
					paymentEventId?: unknown;
					periodMonth?: unknown;
					checkpointAt?: unknown;
					previousCheckpointAt?: unknown;
				};
		  }
		| null
		| undefined;

	if (!report || typeof report !== "object" || !report.checkpoint) {
		fail("stored report_json is missing its checkpoint section");
	}
	const cp = (report as { checkpoint: Record<string, unknown> }).checkpoint;

	const recomputed = await calculateCheckpointReportFingerprint(report);
	if (recomputed !== row.reportFingerprint) {
		fail(
			"recomputed canonical report fingerprint does not match the stored fingerprint",
		);
	}
	if (
		(report as { schemaVersion?: unknown }).schemaVersion !==
			row.reportSchemaVersion ||
		cp.schemaVersion !== row.reportSchemaVersion
	) {
		fail("stored report schemaVersion does not match the snapshot column");
	}
	if (cp.paymentEventId !== row.paymentEventId) {
		fail("stored report paymentEventId does not match the snapshot column");
	}
	if (cp.periodMonth !== row.periodMonth) {
		fail("stored report periodMonth does not match the snapshot column");
	}
	if (cp.checkpointAt !== row.checkpointAt.toISOString()) {
		fail("stored report checkpointAt does not match the snapshot column");
	}
	const prevIso = row.previousCheckpointAt
		? row.previousCheckpointAt.toISOString()
		: null;
	if ((cp.previousCheckpointAt ?? null) !== prevIso) {
		fail(
			"stored report previousCheckpointAt does not match the snapshot column",
		);
	}
}

function fail(reason: string): never {
	throw new BudgetError(
		"BUDGET_CHECKPOINT_SNAPSHOT_CORRUPT",
		`checkpoint snapshot integrity check failed: ${reason}`,
	);
}

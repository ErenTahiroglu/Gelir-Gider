// ============================================================================
// Credit-card statement reconciliation fingerprint
// Deterministic SHA-256 over the reconciliation revision + its ordered
// components, so an exact replay of the same reconciliation is idempotent and
// any divergence is a conflict.
// ============================================================================

async function sha256Hex(data: unknown[]): Promise<string> {
	const serialized = JSON.stringify(data, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export interface ReconciliationComponentFingerprintInput {
	componentNo: number;
	componentType: "PURCHASE" | "ADJUSTMENT";
	amount: string; // normalized money string
	ownership: "PERSONAL" | "EXTERNAL_PERSON";
	personId: string | null;
	purchaseEventId: string | null;
	purchaseSplitRevisionId: string | null;
	adjustmentKind: string | null;
	note: string | null;
}

export interface StatementReconciliationRevisionFingerprintParams {
	userId: string;
	statementId: string;
	operation: "CREATE" | "SUPERSEDE" | "VOID";
	revisionNo: number;
	previousRevisionId: string | null;
	statementRevisionId: string;
	reconciledStatementAmount: string; // normalized money string
	occurredAt: Date;
	components: ReconciliationComponentFingerprintInput[];
}

export function calculateStatementReconciliationRevisionFingerprint(
	params: StatementReconciliationRevisionFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-statement-reconciliation-v1",
		params.userId.trim().toLowerCase(),
		params.statementId.trim().toLowerCase(),
		params.operation,
		params.revisionNo,
		params.previousRevisionId
			? params.previousRevisionId.trim().toLowerCase()
			: null,
		params.statementRevisionId.trim().toLowerCase(),
		params.reconciledStatementAmount,
		params.occurredAt.toISOString(),
		params.components.map((c) => [
			c.componentNo,
			c.componentType,
			c.amount,
			c.ownership,
			c.personId ? c.personId.trim().toLowerCase() : null,
			c.purchaseEventId ? c.purchaseEventId.trim().toLowerCase() : null,
			c.purchaseSplitRevisionId
				? c.purchaseSplitRevisionId.trim().toLowerCase()
				: null,
			c.adjustmentKind,
			c.note,
		]),
	]);
}

// ============================================================================
// People Fingerprint Module
// Deterministic SHA-256 fingerprinting for person/obligation/settlement revisions.
// ============================================================================

async function sha256Hex(data: unknown[]): Promise<string> {
	const serialized = JSON.stringify(data, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Person Revision Fingerprints ----

export interface PersonCreateFingerprintParams {
	userId: string;
	displayName: string;
	relationship: string;
	note: string | null;
	occurredAt: Date;
}

export interface PersonUpdateFingerprintParams {
	userId: string;
	personId: string;
	expectedRevisionNo: number;
	displayName: string;
	relationship: string;
	note: string | null;
	occurredAt: Date;
}

export interface PersonArchiveFingerprintParams {
	userId: string;
	personId: string;
	expectedRevisionNo: number;
	occurredAt: Date;
}

export async function calculatePersonCreateFingerprint(
	params: PersonCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"person-revision-v1",
		params.userId.trim().toLowerCase(),
		"CREATE",
		params.displayName,
		params.relationship,
		params.note ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculatePersonUpdateFingerprint(
	params: PersonUpdateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"person-revision-v1",
		params.userId.trim().toLowerCase(),
		params.personId.trim().toLowerCase(),
		"UPDATE",
		params.expectedRevisionNo,
		params.displayName,
		params.relationship,
		params.note ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculatePersonArchiveFingerprint(
	params: PersonArchiveFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"person-revision-v1",
		params.userId.trim().toLowerCase(),
		params.personId.trim().toLowerCase(),
		"ARCHIVE",
		params.expectedRevisionNo,
		params.occurredAt.toISOString(),
	]);
}

// ---- Obligation Revision Fingerprints ----

export interface ObligationCreateFingerprintParams {
	userId: string;
	personId: string;
	direction: "RECEIVABLE" | "PAYABLE";
	amount: string;
	fundingAssetAccountId: string | null;
	budgetCategory: string | null;
	dueDate: string | null;
	description: string | null;
	occurredAt: Date;
}

export interface ObligationUpdateFingerprintParams {
	userId: string;
	obligationId: string;
	expectedRevisionNo: number;
	amount: string;
	fundingAssetAccountId: string | null;
	budgetCategory: string | null;
	dueDate: string | null;
	description: string | null;
	occurredAt: Date;
}

export interface ObligationVoidFingerprintParams {
	userId: string;
	obligationId: string;
	expectedRevisionNo: number;
}

export async function calculateObligationCreateFingerprint(
	params: ObligationCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"person-obligation-revision-v1",
		params.userId.trim().toLowerCase(),
		params.personId.trim().toLowerCase(),
		"CREATE",
		params.direction,
		params.amount,
		params.fundingAssetAccountId,
		params.budgetCategory,
		params.dueDate,
		params.description,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateObligationUpdateFingerprint(
	params: ObligationUpdateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"person-obligation-revision-v1",
		params.userId.trim().toLowerCase(),
		params.obligationId.trim().toLowerCase(),
		"UPDATE",
		params.expectedRevisionNo,
		params.amount,
		params.fundingAssetAccountId,
		params.budgetCategory,
		params.dueDate,
		params.description,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateObligationVoidFingerprint(
	params: ObligationVoidFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"person-obligation-revision-v1",
		params.userId.trim().toLowerCase(),
		params.obligationId.trim().toLowerCase(),
		"VOID",
		params.expectedRevisionNo,
	]);
}

// ---- Settlement Revision Fingerprints ----

export interface SettlementCreateFingerprintParams {
	userId: string;
	obligationId: string;
	direction: "RECEIVABLE" | "PAYABLE";
	assetAccountId: string;
	cashAmount: string;
	occurredAt: Date;
	note: string | null;
}

export interface SettlementVoidFingerprintParams {
	userId: string;
	settlementId: string;
	expectedRevisionNo: number;
}

export async function calculateSettlementCreateFingerprint(
	params: SettlementCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"person-settlement-revision-v1",
		params.userId.trim().toLowerCase(),
		params.obligationId.trim().toLowerCase(),
		"CREATE",
		params.direction,
		params.assetAccountId,
		params.cashAmount,
		params.occurredAt.toISOString(),
		params.note ?? null,
	]);
}

export async function calculateSettlementVoidFingerprint(
	params: SettlementVoidFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"person-settlement-revision-v1",
		params.userId.trim().toLowerCase(),
		params.settlementId.trim().toLowerCase(),
		"VOID",
		params.expectedRevisionNo,
	]);
}

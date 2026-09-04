// ============================================================================
// Credit Card Fingerprint Module
// Deterministic SHA-256 fingerprinting for card and statement revisions.
// ============================================================================

async function sha256Hex(data: unknown[]): Promise<string> {
	const serialized = JSON.stringify(data);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Card Config Revision Fingerprints ----

export interface CreditCardCreateFingerprintParams {
	userId: string;
	code: string;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string; // normalized money string
	lastFour: string | null;
	note: string | null;
	occurredAt: Date;
}

export interface CreditCardUpdateFingerprintParams {
	userId: string;
	cardId: string;
	expectedRevisionNo: number;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string; // normalized money string
	lastFour: string | null;
	note: string | null;
	changeReason: string | null;
	occurredAt: Date;
}

export interface CreditCardArchiveFingerprintParams {
	userId: string;
	cardId: string;
	expectedRevisionNo: number;
	changeReason: string | null;
	occurredAt: Date;
}

// ---- Statement Revision Fingerprints ----

export interface StatementCreateFingerprintParams {
	userId: string;
	cardId: string;
	cycleYear: number;
	cycleMonth: number;
	statementAmount: string; // normalized money string
	reservePlacement: string;
	note: string | null;
	occurredAt: Date;
}

export interface StatementUpdateFingerprintParams {
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	statementAmount: string; // normalized money string
	reservePlacement: string;
	note: string | null;
	reasonNote: string | null;
	occurredAt: Date;
}

export interface StatementVoidFingerprintParams {
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	reasonNote: string | null;
	occurredAt: Date;
}

export async function calculateCreditCardCreateFingerprint(
	params: CreditCardCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-revision-v1",
		params.userId.trim().toLowerCase(),
		"CREATE",
		params.code,
		params.displayName,
		params.issuer,
		params.statementDay,
		params.dueDay,
		params.creditLimit,
		params.lastFour ?? null,
		params.note ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateCreditCardUpdateFingerprint(
	params: CreditCardUpdateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-revision-v1",
		params.userId.trim().toLowerCase(),
		params.cardId.trim().toLowerCase(),
		"UPDATE",
		params.expectedRevisionNo,
		params.displayName,
		params.issuer,
		params.statementDay,
		params.dueDay,
		params.creditLimit,
		params.lastFour ?? null,
		params.note ?? null,
		params.changeReason ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateCreditCardArchiveFingerprint(
	params: CreditCardArchiveFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-revision-v1",
		params.userId.trim().toLowerCase(),
		params.cardId.trim().toLowerCase(),
		"ARCHIVE",
		params.expectedRevisionNo,
		params.changeReason ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateStatementCreateFingerprint(
	params: StatementCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-statement-revision-v1",
		params.userId.trim().toLowerCase(),
		params.cardId.trim().toLowerCase(),
		"CREATE",
		params.cycleYear,
		params.cycleMonth,
		params.statementAmount,
		params.reservePlacement,
		params.note ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateStatementUpdateFingerprint(
	params: StatementUpdateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-statement-revision-v1",
		params.userId.trim().toLowerCase(),
		params.statementId.trim().toLowerCase(),
		"UPDATE",
		params.expectedRevisionNo,
		params.statementAmount,
		params.reservePlacement,
		params.note ?? null,
		params.reasonNote ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateStatementVoidFingerprint(
	params: StatementVoidFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-statement-revision-v1",
		params.userId.trim().toLowerCase(),
		params.statementId.trim().toLowerCase(),
		"VOID",
		params.expectedRevisionNo,
		params.reasonNote ?? null,
		params.occurredAt.toISOString(),
	]);
}

// ---- Credit Card Liability Event (Purchase & Opening Balance) Fingerprints ----

export interface LiabilityEventCreateFingerprintParams {
	userId: string;
	cardId: string;
	eventType: "PURCHASE" | "OPENING_BALANCE";
	amount: string; // normalized money string
	purchaseCategory: string | null;
	shortTermGoalId: string | null;
	merchant: string | null;
	description: string | null;
	occurredAt: Date;
}

export interface LiabilityEventUpdateFingerprintParams {
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	amount: string; // normalized money string
	purchaseCategory: string | null;
	shortTermGoalId: string | null;
	merchant: string | null;
	description: string | null;
	occurredAt: Date;
}

export interface LiabilityEventVoidFingerprintParams {
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	reasonNote: string | null;
	occurredAt: Date;
}

export async function calculateLiabilityEventCreateFingerprint(
	params: LiabilityEventCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-liability-revision-v1",
		params.userId.trim().toLowerCase(),
		params.cardId.trim().toLowerCase(),
		params.eventType,
		"CREATE",
		params.amount,
		params.purchaseCategory ?? null,
		params.shortTermGoalId ? params.shortTermGoalId.trim().toLowerCase() : null,
		params.merchant ?? null,
		params.description ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateLiabilityEventUpdateFingerprint(
	params: LiabilityEventUpdateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-liability-revision-v1",
		params.userId.trim().toLowerCase(),
		params.eventId.trim().toLowerCase(),
		"UPDATE",
		params.expectedRevisionNo,
		params.amount,
		params.purchaseCategory ?? null,
		params.shortTermGoalId ? params.shortTermGoalId.trim().toLowerCase() : null,
		params.merchant ?? null,
		params.description ?? null,
		params.occurredAt.toISOString(),
	]);
}

export async function calculateLiabilityEventVoidFingerprint(
	params: LiabilityEventVoidFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-liability-revision-v1",
		params.userId.trim().toLowerCase(),
		params.eventId.trim().toLowerCase(),
		"VOID",
		params.expectedRevisionNo,
		params.reasonNote ?? null,
		params.occurredAt.toISOString(),
	]);
}

// ---- Credit Card Statement Payment & Reopen Fingerprints ----

export interface StatementPayFingerprintParams {
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	paymentAmount: string;
	paymentMethod: "MIDAS_FUND" | "OUTSIDE_MIDAS";
	assetAccountId: string;
	occurredAt: Date;
}

export interface StatementReopenFingerprintParams {
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	reasonNote: string | null;
	occurredAt: Date;
}

export async function calculateStatementPayFingerprint(
	params: StatementPayFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-statement-revision-v1",
		params.userId.trim().toLowerCase(),
		params.statementId.trim().toLowerCase(),
		"PAY",
		params.expectedRevisionNo,
		params.paymentAmount,
		params.paymentMethod,
		params.assetAccountId.trim().toLowerCase(),
		params.occurredAt.toISOString(),
	]);
}

export async function calculateStatementReopenFingerprint(
	params: StatementReopenFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"credit-card-statement-revision-v1",
		params.userId.trim().toLowerCase(),
		params.statementId.trim().toLowerCase(),
		"REOPEN",
		params.expectedRevisionNo,
		params.reasonNote ?? null,
		params.occurredAt.toISOString(),
	]);
}

/**
 * Generates a bounded deterministic SHA-256 Midas allocation transfer
 * idempotency key for credit card reserve operations. Format: CARD_RESERVE_<64hex>.
 */
export async function generateCardReserveMidasKey(
	callerKey: string,
	statementId: string,
	namespace: string,
): Promise<string> {
	const hex = await sha256Hex([
		"card-reserve-midas-key",
		callerKey.trim(),
		statementId.trim().toLowerCase(),
		namespace.trim(),
	]);
	return `CARD_RESERVE_${hex}`;
}

/**
 * Generates a bounded deterministic SHA-256 journal posting idempotency key
 * for credit card purchase / opening balance events. Format: CC_LIABILITY_<64hex>.
 */
export async function generateCreditCardLiabilityJournalKey(
	callerKey: string,
	eventId: string,
	revisionNo: number,
): Promise<string> {
	const hex = await sha256Hex([
		"cc-liability-journal-key",
		callerKey.trim(),
		eventId.trim().toLowerCase(),
		revisionNo,
	]);
	return `CC_LIABILITY_${hex}`;
}

/**
 * Generates a bounded deterministic SHA-256 journal posting idempotency key
 * for credit card statement payment events. Format: CC_PAYMENT_<64hex>.
 */
export async function generateCreditCardPaymentJournalKey(
	callerKey: string,
	statementId: string,
	paymentMethod: string,
): Promise<string> {
	const hex = await sha256Hex([
		"cc-payment-journal-key",
		callerKey.trim(),
		statementId.trim().toLowerCase(),
		paymentMethod.trim(),
	]);
	return `CC_PAYMENT_${hex}`;
}

/**
 * Generates a bounded deterministic SHA-256 journal posting idempotency key
 * for credit card statement payment reopen (reversal). Format: CC_REOPEN_<64hex>.
 */
export async function generateCreditCardPaymentReopenJournalKey(
	callerKey: string,
	statementId: string,
	paymentEventId: string,
): Promise<string> {
	const hex = await sha256Hex([
		"cc-payment-reopen-journal-key",
		callerKey.trim(),
		statementId.trim().toLowerCase(),
		paymentEventId.trim().toLowerCase(),
	]);
	return `CC_REOPEN_${hex}`;
}

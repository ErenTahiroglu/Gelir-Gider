import { formatIstanbulPurchaseDate } from "../credit-cards/calendar";

/**
 * Computes a standard lowercase 64-character hex SHA-256 hash using Web Crypto.
 */
export async function computeSha256Hex(
	data: string | Uint8Array,
): Promise<string> {
	const encoded =
		typeof data === "string" ? new TextEncoder().encode(data) : data;
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		encoded as unknown as BufferSource,
	);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes source file/batch content SHA-256 hash.
 */
export async function computeSourceContentHash(
	content: string | Uint8Array,
): Promise<string> {
	return await computeSha256Hex(content);
}

/**
 * Deterministically stringifies any JS object by recursively sorting object keys.
 */
export function canonicalJsonStringify(obj: unknown): string {
	if (obj === null || typeof obj !== "object") {
		return JSON.stringify(obj);
	}
	if (Array.isArray(obj)) {
		return `[${obj.map((item) => canonicalJsonStringify(item)).join(",")}]`;
	}
	const keys = Object.keys(obj as Record<string, unknown>).sort();
	const entries = keys.map(
		(key) =>
			`${JSON.stringify(key)}:${canonicalJsonStringify(
				(obj as Record<string, unknown>)[key],
			)}`,
	);
	return `{${entries.join(",")}}`;
}

/**
 * Computes raw row hash from the raw row input.
 */
export async function computeRawRowHash(raw: unknown): Promise<string> {
	return await computeSha256Hex(canonicalJsonStringify(raw));
}

/**
 * Computes external transaction ID hash from a trimmed external ID.
 */
export async function computeExternalTransactionIdHash(
	externalId: string,
): Promise<string> {
	return await computeSha256Hex(externalId.trim());
}

/**
 * Computes semantic fingerprint for a credit card purchase row.
 */
export async function computeCardSemanticFingerprint(params: {
	userId: string;
	cardId: string | null;
	occurredAt: Date;
	amount: string;
	merchant: string | null;
}): Promise<string> {
	const istanbulDate = formatIstanbulPurchaseDate(params.occurredAt);
	const normalizedMerchant = (params.merchant ?? "").trim().toLowerCase();
	const rawString = [
		params.userId,
		"CREDIT_CARD_PURCHASE",
		params.cardId ?? "NO_CARD",
		istanbulDate,
		params.amount,
		normalizedMerchant,
	].join("|");
	return await computeSha256Hex(rawString);
}

/**
 * Computes semantic fingerprint for an income receipt row.
 */
export async function computeIncomeSemanticFingerprint(params: {
	userId: string;
	incomeSourceId: string | null;
	destinationAccountId: string | null;
	receivedAt: Date;
	amount: string;
}): Promise<string> {
	const istanbulDate = formatIstanbulPurchaseDate(params.receivedAt);
	const rawString = [
		params.userId,
		"INCOME_RECEIPT",
		params.incomeSourceId ?? "NO_SOURCE",
		params.destinationAccountId ?? "NO_DEST",
		istanbulDate,
		params.amount,
	].join("|");
	return await computeSha256Hex(rawString);
}

/**
 * Computes semantic fingerprint for an unsupported row.
 */
export async function computeUnsupportedSemanticFingerprint(params: {
	userId: string;
	rawRowHash: string;
}): Promise<string> {
	const rawString = [params.userId, "UNSUPPORTED", params.rawRowHash].join("|");
	return await computeSha256Hex(rawString);
}

/**
 * Computes revision fingerprint for import_row_revisions.
 */
export async function computeRevisionFingerprint(params: {
	importRowId: string;
	revisionNo: number;
	operation: string;
	status: string;
	payload: unknown;
	reasonNote?: string | null | undefined;
	idempotencyKey?: string | null | undefined;
}): Promise<string> {
	const canonicalPayload = canonicalJsonStringify(params.payload);
	const rawString = [
		params.importRowId,
		params.revisionNo.toString(),
		params.operation,
		params.status,
		params.idempotencyKey ?? "NO_KEY",
		params.reasonNote ?? "NO_NOTE",
		canonicalPayload,
	].join("|");
	return await computeSha256Hex(rawString);
}

/**
 * Computes a deterministic bounded 64-char child idempotency key for domain primitive delegation.
 */
export async function computeChildIdempotencyKey(
	prefix: string,
	rowId: string,
	revisionNo: number,
): Promise<string> {
	const raw = `${prefix}:${rowId}:${revisionNo}`;
	return await computeSha256Hex(raw);
}

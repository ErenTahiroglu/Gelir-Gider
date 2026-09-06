import { validatePurchaseCategory } from "../credit-cards/calendar";
import { parseMoneyString } from "../ledger/money";
import { ImportError } from "./errors";
import {
	computeCardSemanticFingerprint,
	computeExternalTransactionIdHash,
	computeIncomeSemanticFingerprint,
	computeRawRowHash,
	computeUnsupportedSemanticFingerprint,
} from "./fingerprint";

export const MAX_IMPORT_BATCH_ROWS = 5000;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_PROVIDER_LENGTH = 64;
export const MAX_PARSER_TYPE_LENGTH = 64;
export const MAX_PARSER_VERSION_LENGTH = 32;

export interface RawCardPurchaseInput {
	recordType: "CREDIT_CARD_PURCHASE";
	cardId?: string | null | undefined;
	occurredAt: Date | string;
	amount: string;
	purchaseCategory?: string | null | undefined;
	shortTermGoalId?: string | null | undefined;
	merchant?: string | null | undefined;
	description?: string | null | undefined;
	installmentCount?: number | null | undefined;
	externalTransactionId?: string | null | undefined;
	rawRecord?: Record<string, unknown> | undefined;
}

export interface RawIncomeReceiptInput {
	recordType: "INCOME_RECEIPT";
	incomeSourceId?: string | null | undefined;
	destinationAccountId?: string | null | undefined;
	receivedAt: Date | string;
	amount: string;
	note?: string | null | undefined;
	externalTransactionId?: string | null | undefined;
	rawRecord?: Record<string, unknown> | undefined;
}

export interface RawUnsupportedInput {
	recordType: "UNSUPPORTED";
	rawRecord?: Record<string, unknown> | undefined;
	reason?: string | undefined;
	externalTransactionId?: string | null | undefined;
}

export type RawImportRowInput =
	| RawCardPurchaseInput
	| RawIncomeReceiptInput
	| RawUnsupportedInput;

export interface NormalizedCardPurchasePayload {
	recordType: "CREDIT_CARD_PURCHASE";
	cardId: string | null;
	occurredAt: string; // ISO string
	amount: string; // exact normalized decimal "12.34"
	purchaseCategory:
		| "MANDATORY"
		| "DISCRETIONARY"
		| "SHORT_TERM_PURCHASE"
		| "UNCLASSIFIED"
		| null;
	shortTermGoalId: string | null;
	merchant: string | null;
	description: string | null;
	installmentCount: number | null;
}

export interface NormalizedIncomeReceiptPayload {
	recordType: "INCOME_RECEIPT";
	incomeSourceId: string | null;
	destinationAccountId: string | null;
	receivedAt: string; // ISO string
	amount: string; // exact normalized decimal
	note: string | null;
}

export interface NormalizedUnsupportedPayload {
	recordType: "UNSUPPORTED";
	rawRecord: Record<string, unknown>;
	reason: string;
}

export type NormalizedImportPayload =
	| NormalizedCardPurchasePayload
	| NormalizedIncomeReceiptPayload
	| NormalizedUnsupportedPayload;

export interface NormalizedImportRow {
	rowOrdinal: number;
	recordType: "CREDIT_CARD_PURCHASE" | "INCOME_RECEIPT" | "UNSUPPORTED";
	rawRowHash: string;
	semanticFingerprint: string;
	externalTransactionIdHash: string | null;
	initialStatus:
		| "READY"
		| "NEEDS_REVIEW"
		| "POSSIBLE_DUPLICATE"
		| "EXACT_DUPLICATE"
		| "UNSUPPORTED";
	payload: NormalizedImportPayload;
	occurredAt: Date | null;
}

/**
 * Validates batch metadata limits and returns sanitized values.
 */
export function validateAndNormalizeBatchMeta(input: {
	userId: string;
	provider: string;
	sourceKind: string;
	sourceContentHash: string;
	sourceFileName?: string | null | undefined;
	parserType: string;
	parserVersion: string;
	observedAt: Date;
}): {
	validUserId: string;
	validProvider: string;
	validSourceKind: "NORMALIZED_ROWS" | "GENERIC_CSV_V1";
	validContentHash: string;
	validFileName: string | null;
	validParserType: string;
	validParserVersion: string;
	validObservedAt: Date;
} {
	if (
		!input.userId ||
		typeof input.userId !== "string" ||
		input.userId.trim() === ""
	) {
		throw new ImportError("IMPORT_INVALID_INPUT", "userId is required");
	}

	if (!input.provider || typeof input.provider !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "provider is required");
	}
	const validProvider = input.provider.trim();
	if (
		validProvider.length === 0 ||
		validProvider.length > MAX_PROVIDER_LENGTH
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`provider must be between 1 and ${MAX_PROVIDER_LENGTH} characters`,
		);
	}

	if (
		input.sourceKind !== "NORMALIZED_ROWS" &&
		input.sourceKind !== "GENERIC_CSV_V1"
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`Invalid sourceKind: "${input.sourceKind}". Must be NORMALIZED_ROWS or GENERIC_CSV_V1`,
		);
	}

	if (
		!input.sourceContentHash ||
		typeof input.sourceContentHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(input.sourceContentHash.trim())
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"sourceContentHash must be a valid 64-character lowercase hex SHA-256 string",
		);
	}

	let validFileName: string | null = null;
	if (input.sourceFileName != null) {
		if (typeof input.sourceFileName !== "string") {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"sourceFileName must be a string",
			);
		}
		const trimmed = input.sourceFileName.trim();
		if (trimmed.length > MAX_FILENAME_LENGTH) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`sourceFileName must not exceed ${MAX_FILENAME_LENGTH} characters`,
			);
		}
		validFileName = trimmed.length > 0 ? trimmed : null;
	}

	if (!input.parserType || typeof input.parserType !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "parserType is required");
	}
	const validParserType = input.parserType.trim();
	if (
		validParserType.length === 0 ||
		validParserType.length > MAX_PARSER_TYPE_LENGTH
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`parserType must be between 1 and ${MAX_PARSER_TYPE_LENGTH} characters`,
		);
	}

	if (!input.parserVersion || typeof input.parserVersion !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "parserVersion is required");
	}
	const validParserVersion = input.parserVersion.trim();
	if (
		validParserVersion.length === 0 ||
		validParserVersion.length > MAX_PARSER_VERSION_LENGTH
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`parserVersion must be between 1 and ${MAX_PARSER_VERSION_LENGTH} characters`,
		);
	}

	if (
		!(input.observedAt instanceof Date) ||
		Number.isNaN(input.observedAt.getTime())
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid observedAt Date is required",
		);
	}

	return {
		validUserId: input.userId.trim(),
		validProvider,
		validSourceKind: input.sourceKind,
		validContentHash: input.sourceContentHash.trim().toLowerCase(),
		validFileName,
		validParserType,
		validParserVersion,
		validObservedAt: input.observedAt,
	};
}

/**
 * Normalizes a single row input asynchronously.
 */
export async function normalizeImportRow(
	userId: string,
	rowOrdinal: number,
	input: RawImportRowInput,
): Promise<NormalizedImportRow> {
	if (rowOrdinal < 0 || !Number.isInteger(rowOrdinal)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`rowOrdinal must be a non-negative integer, got ${rowOrdinal}`,
		);
	}

	if (!input || typeof input !== "object") {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`Invalid row at ordinal ${rowOrdinal}: must be an object`,
		);
	}

	const rawRowHash = await computeRawRowHash(input);
	const externalTransactionIdHash =
		typeof input.externalTransactionId === "string" &&
		input.externalTransactionId.trim().length > 0
			? await computeExternalTransactionIdHash(input.externalTransactionId)
			: null;

	if (input.recordType === "CREDIT_CARD_PURCHASE") {
		const cardId =
			typeof input.cardId === "string" && input.cardId.trim().length > 0
				? input.cardId.trim()
				: null;

		const occurredDate =
			input.occurredAt instanceof Date
				? input.occurredAt
				: new Date(input.occurredAt);

		if (Number.isNaN(occurredDate.getTime())) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: invalid occurredAt date: ${String(input.occurredAt)}`,
			);
		}

		let normalizedAmount: string;
		try {
			const parsed = parseMoneyString(input.amount);
			if (parsed.cents <= 0n) {
				throw new Error("Amount must be strictly positive");
			}
			normalizedAmount = parsed.normalized;
		} catch (err) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: invalid credit card purchase amount "${String(input.amount)}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		let purchaseCategory:
			| "MANDATORY"
			| "DISCRETIONARY"
			| "SHORT_TERM_PURCHASE"
			| "UNCLASSIFIED"
			| null = null;

		if (
			input.purchaseCategory != null &&
			String(input.purchaseCategory).trim() !== ""
		) {
			const trimmedCat = String(input.purchaseCategory).trim();
			try {
				purchaseCategory = validatePurchaseCategory(trimmedCat);
			} catch {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: invalid purchaseCategory "${trimmedCat}". Must be MANDATORY, DISCRETIONARY, SHORT_TERM_PURCHASE, or UNCLASSIFIED`,
				);
			}
		}

		const shortTermGoalId =
			typeof input.shortTermGoalId === "string" &&
			input.shortTermGoalId.trim().length > 0
				? input.shortTermGoalId.trim()
				: null;

		if (purchaseCategory === "SHORT_TERM_PURCHASE" && !shortTermGoalId) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: shortTermGoalId is required when purchaseCategory is SHORT_TERM_PURCHASE`,
			);
		}

		if (purchaseCategory !== "SHORT_TERM_PURCHASE" && shortTermGoalId) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: shortTermGoalId is forbidden when purchaseCategory is not SHORT_TERM_PURCHASE`,
			);
		}

		const merchant =
			typeof input.merchant === "string" && input.merchant.trim().length > 0
				? input.merchant.trim().slice(0, 255)
				: null;

		const description =
			typeof input.description === "string" &&
			input.description.trim().length > 0
				? input.description.trim().slice(0, 500)
				: null;

		let installmentCount: number | null = null;
		if (input.installmentCount != null) {
			const num = Number(input.installmentCount);
			if (!Number.isInteger(num) || num < 1 || num > 36) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: installmentCount must be an integer between 1 and 36, got ${input.installmentCount}`,
				);
			}
			installmentCount = num;
		}

		const payload: NormalizedCardPurchasePayload = {
			recordType: "CREDIT_CARD_PURCHASE",
			cardId,
			occurredAt: occurredDate.toISOString(),
			amount: normalizedAmount,
			purchaseCategory,
			shortTermGoalId,
			merchant,
			description,
			installmentCount,
		};

		const semanticFingerprint = await computeCardSemanticFingerprint({
			userId,
			cardId,
			occurredAt: occurredDate,
			amount: normalizedAmount,
			merchant,
		});

		// To be READY: cardId and purchaseCategory are required.
		const isReady = cardId !== null && purchaseCategory !== null;
		const initialStatus = isReady ? "READY" : "NEEDS_REVIEW";

		return {
			rowOrdinal,
			recordType: "CREDIT_CARD_PURCHASE",
			rawRowHash,
			semanticFingerprint,
			externalTransactionIdHash,
			initialStatus,
			payload,
			occurredAt: occurredDate,
		};
	}

	if (input.recordType === "INCOME_RECEIPT") {
		const incomeSourceId =
			typeof input.incomeSourceId === "string" &&
			input.incomeSourceId.trim().length > 0
				? input.incomeSourceId.trim()
				: null;

		const destinationAccountId =
			typeof input.destinationAccountId === "string" &&
			input.destinationAccountId.trim().length > 0
				? input.destinationAccountId.trim()
				: null;

		const receivedDate =
			input.receivedAt instanceof Date
				? input.receivedAt
				: new Date(input.receivedAt);

		if (Number.isNaN(receivedDate.getTime())) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: invalid receivedAt date: ${String(input.receivedAt)}`,
			);
		}

		let normalizedAmount: string;
		try {
			const parsed = parseMoneyString(input.amount);
			if (parsed.cents <= 0n) {
				throw new Error("Amount must be strictly positive");
			}
			normalizedAmount = parsed.normalized;
		} catch (err) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: invalid income receipt amount "${String(input.amount)}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const note =
			typeof input.note === "string" && input.note.trim().length > 0
				? input.note.trim().slice(0, 500)
				: null;

		const payload: NormalizedIncomeReceiptPayload = {
			recordType: "INCOME_RECEIPT",
			incomeSourceId,
			destinationAccountId,
			receivedAt: receivedDate.toISOString(),
			amount: normalizedAmount,
			note,
		};

		const semanticFingerprint = await computeIncomeSemanticFingerprint({
			userId,
			incomeSourceId,
			destinationAccountId,
			receivedAt: receivedDate,
			amount: normalizedAmount,
		});

		// To be READY: incomeSourceId and destinationAccountId are required.
		const isReady = incomeSourceId !== null && destinationAccountId !== null;
		const initialStatus = isReady ? "READY" : "NEEDS_REVIEW";

		return {
			rowOrdinal,
			recordType: "INCOME_RECEIPT",
			rawRowHash,
			semanticFingerprint,
			externalTransactionIdHash,
			initialStatus,
			payload,
			occurredAt: receivedDate,
		};
	}

	if (input.recordType === "UNSUPPORTED") {
		const payload: NormalizedUnsupportedPayload = {
			recordType: "UNSUPPORTED",
			rawRecord: input.rawRecord ?? {},
			reason: input.reason ?? "Unsupported record type",
		};

		const semanticFingerprint = await computeUnsupportedSemanticFingerprint({
			userId,
			rawRowHash,
		});

		return {
			rowOrdinal,
			recordType: "UNSUPPORTED",
			rawRowHash,
			semanticFingerprint,
			externalTransactionIdHash,
			initialStatus: "UNSUPPORTED",
			payload,
			occurredAt: null,
		};
	}

	throw new ImportError(
		"IMPORT_INVALID_INPUT",
		`Row ${rowOrdinal}: unsupported recordType "${String((input as { recordType?: unknown }).recordType)}"`,
	);
}

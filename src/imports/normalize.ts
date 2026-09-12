import { validatePurchaseCategory } from "../credit-cards/calendar";
import { parseMoneyString } from "../ledger/money";
import { ImportError } from "./errors";
import {
	canonicalJsonStringify,
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
export const MAX_SOURCE_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_RAW_RECORD_SERIALIZED_BYTES = 64 * 1024; // 64KB

const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(val: unknown): val is string {
	return typeof val === "string" && UUID_REGEX.test(val.trim());
}

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
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"batch metadata input must be an object",
		);
	}

	const allowedBatchMetaKeys = new Set([
		"userId",
		"provider",
		"sourceKind",
		"sourceContentHash",
		"sourceFileName",
		"parserType",
		"parserVersion",
		"observedAt",
	]);
	for (const key of Object.keys(input)) {
		if (!allowedBatchMetaKeys.has(key)) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Unknown property "${key}" in batch metadata`,
			);
		}
	}

	if (
		!input.userId ||
		typeof input.userId !== "string" ||
		!isValidUuid(input.userId)
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid userId UUID is required",
		);
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
			`Invalid sourceKind: "${String(input.sourceKind)}". Must be NORMALIZED_ROWS or GENERIC_CSV_V1`,
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
		validUserId: input.userId.trim().toLowerCase(),
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

	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`Invalid row at ordinal ${rowOrdinal}: must be an object`,
		);
	}

	if (
		input.externalTransactionId !== undefined &&
		input.externalTransactionId !== null &&
		typeof input.externalTransactionId !== "string"
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`Row ${rowOrdinal}: externalTransactionId must be a string`,
		);
	}

	if (input.rawRecord !== undefined && input.rawRecord !== null) {
		if (typeof input.rawRecord !== "object" || Array.isArray(input.rawRecord)) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: rawRecord must be an object`,
			);
		}
		try {
			const serialized = canonicalJsonStringify(input.rawRecord);
			const byteLen = new TextEncoder().encode(serialized).length;
			if (byteLen > MAX_RAW_RECORD_SERIALIZED_BYTES) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: rawRecord serialized size exceeds maximum of ${MAX_RAW_RECORD_SERIALIZED_BYTES} bytes (got ${byteLen})`,
				);
			}
		} catch (err) {
			if (err instanceof ImportError) {
				throw err;
			}
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: rawRecord contains circular reference or unserializable data`,
				{ cause: err },
			);
		}
	}

	let rawRowHash: string;
	try {
		rawRowHash = await computeRawRowHash(input);
	} catch (err) {
		if (err instanceof ImportError) {
			throw err;
		}
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`Row ${rowOrdinal}: failed to compute raw row hash: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}

	const externalTransactionIdHash =
		typeof input.externalTransactionId === "string" &&
		input.externalTransactionId.trim().length > 0
			? await computeExternalTransactionIdHash(input.externalTransactionId)
			: null;

	if (input.recordType === "CREDIT_CARD_PURCHASE") {
		const allowedKeys = new Set([
			"recordType",
			"cardId",
			"occurredAt",
			"amount",
			"purchaseCategory",
			"shortTermGoalId",
			"merchant",
			"description",
			"installmentCount",
			"externalTransactionId",
			"rawRecord",
		]);
		for (const key of Object.keys(input)) {
			if (!allowedKeys.has(key)) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: unknown property "${key}" in CREDIT_CARD_PURCHASE input`,
				);
			}
		}

		let cardId: string | null = null;
		if (input.cardId != null) {
			if (typeof input.cardId !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: cardId must be a string`,
				);
			}
			const trimmed = input.cardId.trim();
			if (trimmed.length > 0) {
				if (!isValidUuid(trimmed)) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						`Row ${rowOrdinal}: invalid cardId UUID: "${input.cardId}"`,
					);
				}
				cardId = trimmed.toLowerCase();
			}
		}

		if (
			!(input.occurredAt instanceof Date) &&
			typeof input.occurredAt !== "string"
		) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: occurredAt must be a Date or ISO date string`,
			);
		}

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

		if (typeof input.amount !== "string") {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: amount must be a decimal string`,
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

		if (input.purchaseCategory != null) {
			if (typeof input.purchaseCategory !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: purchaseCategory must be a string`,
				);
			}
			const trimmedCat = input.purchaseCategory.trim();
			if (trimmedCat !== "") {
				try {
					const validated = validatePurchaseCategory(trimmedCat);
					purchaseCategory =
						validated === "MANDATORY_EXPENSE"
							? "MANDATORY"
							: validated === "DISCRETIONARY_SPEND"
								? "DISCRETIONARY"
								: validated;
				} catch {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						`Row ${rowOrdinal}: invalid purchaseCategory "${trimmedCat}". Must be MANDATORY, DISCRETIONARY, SHORT_TERM_PURCHASE, or UNCLASSIFIED`,
					);
				}
			}
		}

		let shortTermGoalId: string | null = null;
		if (input.shortTermGoalId != null) {
			if (typeof input.shortTermGoalId !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: shortTermGoalId must be a string`,
				);
			}
			const trimmed = input.shortTermGoalId.trim();
			if (trimmed.length > 0) {
				if (!isValidUuid(trimmed)) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						`Row ${rowOrdinal}: invalid shortTermGoalId UUID: "${input.shortTermGoalId}"`,
					);
				}
				shortTermGoalId = trimmed.toLowerCase();
			}
		}

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

		let merchant: string | null = null;
		if (input.merchant != null) {
			if (typeof input.merchant !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: merchant must be a string`,
				);
			}
			const trimmed = input.merchant.trim();
			if (trimmed.length > 200) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: merchant must not exceed 200 characters`,
				);
			}
			merchant = trimmed.length > 0 ? trimmed : null;
		}

		let description: string | null = null;
		if (input.description != null) {
			if (typeof input.description !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: description must be a string`,
				);
			}
			const trimmed = input.description.trim();
			if (trimmed.length > 500) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: description must not exceed 500 characters`,
				);
			}
			description = trimmed.length > 0 ? trimmed : null;
		}

		let installmentCount: number | null = null;
		if (input.installmentCount != null) {
			if (
				typeof input.installmentCount !== "number" ||
				!Number.isInteger(input.installmentCount) ||
				input.installmentCount < 1 ||
				input.installmentCount > 60
			) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: installmentCount must be an integer between 1 and 60, got ${String(input.installmentCount)}`,
				);
			}
			installmentCount = input.installmentCount;
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
		const allowedKeys = new Set([
			"recordType",
			"incomeSourceId",
			"destinationAccountId",
			"receivedAt",
			"amount",
			"note",
			"externalTransactionId",
			"rawRecord",
		]);
		for (const key of Object.keys(input)) {
			if (!allowedKeys.has(key)) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: unknown property "${key}" in INCOME_RECEIPT input`,
				);
			}
		}

		let incomeSourceId: string | null = null;
		if (input.incomeSourceId != null) {
			if (typeof input.incomeSourceId !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: incomeSourceId must be a string`,
				);
			}
			const trimmed = input.incomeSourceId.trim();
			if (trimmed.length > 0) {
				if (!isValidUuid(trimmed)) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						`Row ${rowOrdinal}: invalid incomeSourceId UUID: "${input.incomeSourceId}"`,
					);
				}
				incomeSourceId = trimmed.toLowerCase();
			}
		}

		let destinationAccountId: string | null = null;
		if (input.destinationAccountId != null) {
			if (typeof input.destinationAccountId !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: destinationAccountId must be a string`,
				);
			}
			const trimmed = input.destinationAccountId.trim();
			if (trimmed.length > 0) {
				if (!isValidUuid(trimmed)) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						`Row ${rowOrdinal}: invalid destinationAccountId UUID: "${input.destinationAccountId}"`,
					);
				}
				destinationAccountId = trimmed.toLowerCase();
			}
		}

		if (
			!(input.receivedAt instanceof Date) &&
			typeof input.receivedAt !== "string"
		) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: receivedAt must be a Date or ISO date string`,
			);
		}

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

		if (typeof input.amount !== "string") {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`Row ${rowOrdinal}: amount must be a decimal string`,
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

		let note: string | null = null;
		if (input.note != null) {
			if (typeof input.note !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: note must be a string`,
				);
			}
			const trimmed = input.note.trim();
			if (trimmed.length > 500) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: note must not exceed 500 characters`,
				);
			}
			note = trimmed.length > 0 ? trimmed : null;
		}

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
		const allowedKeys = new Set([
			"recordType",
			"reason",
			"externalTransactionId",
			"rawRecord",
		]);
		for (const key of Object.keys(input)) {
			if (!allowedKeys.has(key)) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: unknown property "${key}" in UNSUPPORTED input`,
				);
			}
		}

		let reason = "Unsupported record type";
		if (input.reason != null) {
			if (typeof input.reason !== "string") {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: reason must be a string`,
				);
			}
			const trimmed = input.reason.trim();
			if (trimmed.length > 500) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					`Row ${rowOrdinal}: reason must not exceed 500 characters`,
				);
			}
			reason = trimmed.length > 0 ? trimmed : "Unsupported record type";
		}

		const payload: NormalizedUnsupportedPayload = {
			recordType: "UNSUPPORTED",
			reason,
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

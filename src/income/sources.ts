import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/auth";
import { incomeSources } from "../db/schema/income";
import { ledgerAccounts } from "../db/schema/ledger";
import { parseMoneyString } from "../ledger/money";
import { IncomeError } from "./errors";

export type IncomeNature = "REGULAR" | "EXTRA" | "SUPPORT";
export type IncomeReferenceMethod =
	| "FIXED_MONTHLY"
	| "SEASONAL_ANNUALIZED"
	| "ROLLING_MEDIAN"
	| "EXCLUDED";

export interface IncomeSourceItem {
	id: string;
	userId: string;
	code: string;
	name: string;
	nature: IncomeNature;
	referenceMethod: IncomeReferenceMethod;
	expectedMonthlyAmount: string | null;
	seasonalMonthsPerYear: number | null;
	rollingMedianMonths: number | null;
	incomeLedgerAccountId: string;
	activeFrom: string;
	activeUntil: string | null;
	createdAt: Date;
	archivedAt: Date | null;
}

export interface CreateIncomeSourceParams {
	db: Database;
	userId: string;
	code: string;
	name: string;
	nature: IncomeNature;
	referenceMethod: IncomeReferenceMethod;
	expectedMonthlyAmount?: string | null | undefined;
	seasonalMonthsPerYear?: number | null | undefined;
	rollingMedianMonths?: number | null | undefined;
	incomeLedgerAccountId: string;
	activeFrom: string;
	activeUntil?: string | null | undefined;
}

export interface ArchiveIncomeSourceParams {
	db: Database;
	userId: string;
	sourceId: string;
}

export interface GetIncomeSourceParams {
	db: Database;
	userId: string;
	sourceId: string;
}

export interface ListIncomeSourcesParams {
	db: Database;
	userId: string;
	includeArchived?: boolean | undefined;
}

const SOURCE_CODE_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;
const DATE_FORMAT_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Creates an immutable income source definition.
 */
export async function createIncomeSource(
	params: CreateIncomeSourceParams,
): Promise<IncomeSourceItem> {
	const { db, userId, nature, referenceMethod, incomeLedgerAccountId } = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const normalizedCode = params.code?.trim().toUpperCase();
	if (!normalizedCode || !SOURCE_CODE_REGEX.test(normalizedCode)) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Income source code must match pattern '^[A-Z][A-Z0-9_]{1,63}$', received: '${params.code}'`,
		);
	}

	const normalizedName = params.name?.trim();
	if (!normalizedName || normalizedName.length > 120) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Income source name must be between 1 and 120 characters",
		);
	}

	if (!["REGULAR", "EXTRA", "SUPPORT"].includes(nature)) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid income nature: '${nature}'`,
		);
	}

	if (
		![
			"FIXED_MONTHLY",
			"SEASONAL_ANNUALIZED",
			"ROLLING_MEDIAN",
			"EXCLUDED",
		].includes(referenceMethod)
	) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid reference method: '${referenceMethod}'`,
		);
	}

	// Invariant: EXTRA and SUPPORT must use EXCLUDED reference method
	if (["EXTRA", "SUPPORT"].includes(nature) && referenceMethod !== "EXCLUDED") {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Income nature '${nature}' must use reference method 'EXCLUDED'`,
		);
	}

	// Method-specific parameter validation
	let normalizedExpectedMonthlyAmount: string | null = null;
	let normalizedSeasonalMonths: number | null = null;
	let normalizedRollingMedianMonths: number | null = null;

	if (referenceMethod === "FIXED_MONTHLY") {
		if (!params.expectedMonthlyAmount) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"expectedMonthlyAmount is required for FIXED_MONTHLY reference method",
			);
		}
		const parsed = parseMoneyString(params.expectedMonthlyAmount);
		if (parsed.cents <= 0n) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"expectedMonthlyAmount must be strictly positive",
			);
		}
		normalizedExpectedMonthlyAmount = parsed.normalized;

		if (
			params.seasonalMonthsPerYear != null ||
			params.rollingMedianMonths != null
		) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"seasonalMonthsPerYear and rollingMedianMonths must be null for FIXED_MONTHLY",
			);
		}
	} else if (referenceMethod === "SEASONAL_ANNUALIZED") {
		if (!params.expectedMonthlyAmount) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"expectedMonthlyAmount is required for SEASONAL_ANNUALIZED reference method",
			);
		}
		const parsed = parseMoneyString(params.expectedMonthlyAmount);
		if (parsed.cents <= 0n) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"expectedMonthlyAmount must be strictly positive",
			);
		}
		normalizedExpectedMonthlyAmount = parsed.normalized;

		if (
			params.seasonalMonthsPerYear == null ||
			params.seasonalMonthsPerYear < 1 ||
			params.seasonalMonthsPerYear > 12 ||
			!Number.isInteger(params.seasonalMonthsPerYear)
		) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"seasonalMonthsPerYear must be an integer between 1 and 12",
			);
		}
		normalizedSeasonalMonths = params.seasonalMonthsPerYear;

		if (params.rollingMedianMonths != null) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"rollingMedianMonths must be null for SEASONAL_ANNUALIZED",
			);
		}
	} else if (referenceMethod === "ROLLING_MEDIAN") {
		if (
			params.rollingMedianMonths == null ||
			params.rollingMedianMonths < 1 ||
			params.rollingMedianMonths > 24 ||
			!Number.isInteger(params.rollingMedianMonths)
		) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"rollingMedianMonths must be an integer between 1 and 24",
			);
		}
		normalizedRollingMedianMonths = params.rollingMedianMonths;

		if (params.seasonalMonthsPerYear != null) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"seasonalMonthsPerYear must be null for ROLLING_MEDIAN",
			);
		}
	} else if (referenceMethod === "EXCLUDED") {
		if (
			params.seasonalMonthsPerYear != null ||
			params.rollingMedianMonths != null
		) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"seasonalMonthsPerYear and rollingMedianMonths must be null for EXCLUDED",
			);
		}
		if (params.expectedMonthlyAmount) {
			const parsed = parseMoneyString(params.expectedMonthlyAmount);
			normalizedExpectedMonthlyAmount = parsed.normalized;
		}
	}

	// Active date range validation
	const activeFrom = params.activeFrom?.trim();
	if (!activeFrom || !DATE_FORMAT_REGEX.test(activeFrom)) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"activeFrom must be a valid date formatted as YYYY-MM-DD",
		);
	}

	let activeUntil: string | null = null;
	if (params.activeUntil) {
		activeUntil = params.activeUntil.trim();
		if (!DATE_FORMAT_REGEX.test(activeUntil)) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"activeUntil must be a valid date formatted as YYYY-MM-DD",
			);
		}
		if (activeUntil < activeFrom) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"activeUntil must be greater than or equal to activeFrom",
			);
		}
	}

	// Check user existence
	const [user] = await db
		.select({ currency: users.currency })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		throw new IncomeError("INCOME_INVALID_INPUT", "User not found");
	}

	// Check income ledger account
	const trimmedAccountId = incomeLedgerAccountId?.trim();
	if (!trimmedAccountId) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"incomeLedgerAccountId is required",
		);
	}

	const [account] = await db
		.select({
			id: ledgerAccounts.id,
			userId: ledgerAccounts.userId,
			accountType: ledgerAccounts.accountType,
			normalBalance: ledgerAccounts.normalBalance,
			currency: ledgerAccounts.currency,
			archivedAt: ledgerAccounts.archivedAt,
		})
		.from(ledgerAccounts)
		.where(
			and(
				eq(ledgerAccounts.id, trimmedAccountId),
				eq(ledgerAccounts.userId, userId),
			),
		)
		.limit(1);

	if (!account) {
		throw new IncomeError(
			"INCOME_LEDGER_ACCOUNT_INVALID",
			`Ledger account "${trimmedAccountId}" not found for this user`,
		);
	}

	if (account.accountType !== "INCOME" || account.normalBalance !== "CREDIT") {
		throw new IncomeError(
			"INCOME_LEDGER_ACCOUNT_INVALID",
			`Income ledger account must have accountType='INCOME' and normalBalance='CREDIT', found accountType='${account.accountType}', normalBalance='${account.normalBalance}'`,
		);
	}

	if (account.currency !== user.currency) {
		throw new IncomeError(
			"INCOME_LEDGER_ACCOUNT_INVALID",
			`Income ledger account currency '${account.currency}' does not match user currency '${user.currency}'`,
		);
	}

	if (account.archivedAt !== null) {
		throw new IncomeError(
			"INCOME_LEDGER_ACCOUNT_INVALID",
			"Cannot create income source with an archived ledger account",
		);
	}

	// Insert income source with unique conflict protection
	const [insertedSource] = await db
		.insert(incomeSources)
		.values({
			userId,
			code: normalizedCode,
			name: normalizedName,
			nature,
			referenceMethod,
			expectedMonthlyAmount: normalizedExpectedMonthlyAmount,
			seasonalMonthsPerYear: normalizedSeasonalMonths,
			rollingMedianMonths: normalizedRollingMedianMonths,
			incomeLedgerAccountId: account.id,
			activeFrom,
			activeUntil,
		})
		.onConflictDoNothing({
			target: [incomeSources.userId, incomeSources.code],
		})
		.returning();

	if (!insertedSource) {
		throw new IncomeError(
			"INCOME_SOURCE_CODE_CONFLICT",
			`Income source code '${normalizedCode}' already exists for this user`,
		);
	}

	return {
		id: insertedSource.id,
		userId: insertedSource.userId,
		code: insertedSource.code,
		name: insertedSource.name,
		nature: insertedSource.nature as IncomeNature,
		referenceMethod: insertedSource.referenceMethod as IncomeReferenceMethod,
		expectedMonthlyAmount: insertedSource.expectedMonthlyAmount,
		seasonalMonthsPerYear: insertedSource.seasonalMonthsPerYear,
		rollingMedianMonths: insertedSource.rollingMedianMonths,
		incomeLedgerAccountId: insertedSource.incomeLedgerAccountId,
		activeFrom: insertedSource.activeFrom,
		activeUntil: insertedSource.activeUntil,
		createdAt: insertedSource.createdAt,
		archivedAt: insertedSource.archivedAt,
	};
}

/**
 * Archives an income source. Idempotent if already archived.
 */
export async function archiveIncomeSource({
	db,
	userId,
	sourceId,
}: ArchiveIncomeSourceParams): Promise<IncomeSourceItem> {
	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const trimmedSourceId = sourceId?.trim();
	if (!trimmedSourceId) {
		throw new IncomeError("INCOME_INVALID_INPUT", "Source ID is required");
	}

	const [source] = await db
		.select()
		.from(incomeSources)
		.where(
			and(
				eq(incomeSources.id, trimmedSourceId),
				eq(incomeSources.userId, userId),
			),
		)
		.limit(1);

	if (!source) {
		throw new IncomeError(
			"INCOME_SOURCE_NOT_FOUND",
			`Income source "${trimmedSourceId}" not found`,
		);
	}

	if (source.archivedAt !== null) {
		return {
			id: source.id,
			userId: source.userId,
			code: source.code,
			name: source.name,
			nature: source.nature as IncomeNature,
			referenceMethod: source.referenceMethod as IncomeReferenceMethod,
			expectedMonthlyAmount: source.expectedMonthlyAmount,
			seasonalMonthsPerYear: source.seasonalMonthsPerYear,
			rollingMedianMonths: source.rollingMedianMonths,
			incomeLedgerAccountId: source.incomeLedgerAccountId,
			activeFrom: source.activeFrom,
			activeUntil: source.activeUntil,
			createdAt: source.createdAt,
			archivedAt: source.archivedAt,
		};
	}

	const [archived] = await db
		.update(incomeSources)
		.set({ archivedAt: new Date() })
		.where(
			and(
				eq(incomeSources.id, trimmedSourceId),
				eq(incomeSources.userId, userId),
				isNull(incomeSources.archivedAt),
			),
		)
		.returning();

	const finalSource = archived ?? source;

	return {
		id: finalSource.id,
		userId: finalSource.userId,
		code: finalSource.code,
		name: finalSource.name,
		nature: finalSource.nature as IncomeNature,
		referenceMethod: finalSource.referenceMethod as IncomeReferenceMethod,
		expectedMonthlyAmount: finalSource.expectedMonthlyAmount,
		seasonalMonthsPerYear: finalSource.seasonalMonthsPerYear,
		rollingMedianMonths: finalSource.rollingMedianMonths,
		incomeLedgerAccountId: finalSource.incomeLedgerAccountId,
		activeFrom: finalSource.activeFrom,
		activeUntil: finalSource.activeUntil,
		createdAt: finalSource.createdAt,
		archivedAt: finalSource.archivedAt,
	};
}

/**
 * Fetches an income source by ID.
 */
export async function getIncomeSource({
	db,
	userId,
	sourceId,
}: GetIncomeSourceParams): Promise<IncomeSourceItem> {
	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const trimmedSourceId = sourceId?.trim();
	if (!trimmedSourceId) {
		throw new IncomeError("INCOME_INVALID_INPUT", "Source ID is required");
	}

	const [source] = await db
		.select()
		.from(incomeSources)
		.where(
			and(
				eq(incomeSources.id, trimmedSourceId),
				eq(incomeSources.userId, userId),
			),
		)
		.limit(1);

	if (!source) {
		throw new IncomeError(
			"INCOME_SOURCE_NOT_FOUND",
			`Income source "${trimmedSourceId}" not found`,
		);
	}

	return {
		id: source.id,
		userId: source.userId,
		code: source.code,
		name: source.name,
		nature: source.nature as IncomeNature,
		referenceMethod: source.referenceMethod as IncomeReferenceMethod,
		expectedMonthlyAmount: source.expectedMonthlyAmount,
		seasonalMonthsPerYear: source.seasonalMonthsPerYear,
		rollingMedianMonths: source.rollingMedianMonths,
		incomeLedgerAccountId: source.incomeLedgerAccountId,
		activeFrom: source.activeFrom,
		activeUntil: source.activeUntil,
		createdAt: source.createdAt,
		archivedAt: source.archivedAt,
	};
}

/**
 * Lists all income sources for a user.
 */
export async function listIncomeSources({
	db,
	userId,
	includeArchived = false,
}: ListIncomeSourcesParams): Promise<IncomeSourceItem[]> {
	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const conditions = [eq(incomeSources.userId, userId)];
	if (!includeArchived) {
		conditions.push(isNull(incomeSources.archivedAt));
	}

	const results = await db
		.select()
		.from(incomeSources)
		.where(and(...conditions))
		.orderBy(desc(incomeSources.createdAt));

	return results.map((source) => ({
		id: source.id,
		userId: source.userId,
		code: source.code,
		name: source.name,
		nature: source.nature as IncomeNature,
		referenceMethod: source.referenceMethod as IncomeReferenceMethod,
		expectedMonthlyAmount: source.expectedMonthlyAmount,
		seasonalMonthsPerYear: source.seasonalMonthsPerYear,
		rollingMedianMonths: source.rollingMedianMonths,
		incomeLedgerAccountId: source.incomeLedgerAccountId,
		activeFrom: source.activeFrom,
		activeUntil: source.activeUntil,
		createdAt: source.createdAt,
		archivedAt: source.archivedAt,
	}));
}

import { and, eq } from "drizzle-orm";
import { incomeSources } from "../db/schema/income";
import { parseMoneyString } from "../ledger/money";
import { validateIsoCalendarDate } from "./calendar";
import { IncomeError } from "./errors";
import {
	type CreateIncomeSourceParams,
	createIncomeSource,
	type IncomeSourceItem,
} from "./sources";

export interface CreateIncomeSourceWithNaturalReplayResult {
	incomeSource: IncomeSourceItem;
	idempotentReplay: boolean;
}

/**
 * Creates an immutable income source or absorbs an identical natural-key replay.
 * Natural key: (userId, normalized source code).
 *
 * Rules:
 * 1. Fresh create -> resource created, idempotentReplay: false
 * 2. Exact retry with same normalized immutable definition -> return existing, idempotentReplay: true
 * 3. Same code with different semantic definition -> throw INCOME_SOURCE_CODE_CONFLICT
 */
export async function createIncomeSourceWithNaturalReplay(
	params: CreateIncomeSourceParams,
): Promise<CreateIncomeSourceWithNaturalReplayResult> {
	const { db, userId, code } = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const normalizedCode = code?.trim().toUpperCase();

	try {
		const created = await createIncomeSource(params);
		return {
			incomeSource: created,
			idempotentReplay: false,
		};
	} catch (err) {
		if (
			err instanceof IncomeError &&
			err.code === "INCOME_SOURCE_CODE_CONFLICT"
		) {
			// Query existing row by natural unique key (userId, code)
			const [existing] = await db
				.select()
				.from(incomeSources)
				.where(
					and(
						eq(incomeSources.userId, userId),
						eq(incomeSources.code, normalizedCode),
					),
				)
				.limit(1);

			if (!existing) {
				// Re-throw original conflict if row somehow not found
				throw err;
			}

			// Compare normalized definitions
			const normalizedName = params.name?.trim();
			if (existing.name !== normalizedName) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different name`,
				);
			}

			if (existing.nature !== params.nature) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different nature`,
				);
			}

			if (existing.referenceMethod !== params.referenceMethod) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different referenceMethod`,
				);
			}

			let expectedMonthlyAmountNormalized: string | null = null;
			if (params.expectedMonthlyAmount) {
				try {
					expectedMonthlyAmountNormalized = parseMoneyString(
						params.expectedMonthlyAmount,
					).normalized;
				} catch {
					// Validation will have failed in createIncomeSource, but if reached here:
					throw new IncomeError(
						"INCOME_INVALID_INPUT",
						"Invalid expectedMonthlyAmount",
					);
				}
			}

			if (existing.expectedMonthlyAmount !== expectedMonthlyAmountNormalized) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different expectedMonthlyAmount`,
				);
			}

			const seasonalMonths = params.seasonalMonthsPerYear ?? null;
			if (existing.seasonalMonthsPerYear !== seasonalMonths) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different seasonalMonthsPerYear`,
				);
			}

			const rollingMonths = params.rollingMedianMonths ?? null;
			if (existing.rollingMedianMonths !== rollingMonths) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different rollingMedianMonths`,
				);
			}

			const trimmedAccountId = params.incomeLedgerAccountId?.trim();
			if (existing.incomeLedgerAccountId !== trimmedAccountId) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different incomeLedgerAccountId`,
				);
			}

			const normalizedActiveFrom = validateIsoCalendarDate(params.activeFrom);
			if (existing.activeFrom !== normalizedActiveFrom) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different activeFrom`,
				);
			}

			let normalizedActiveUntil: string | null = null;
			if (params.activeUntil) {
				normalizedActiveUntil = validateIsoCalendarDate(params.activeUntil);
			}
			if (existing.activeUntil !== normalizedActiveUntil) {
				throw new IncomeError(
					"INCOME_SOURCE_CODE_CONFLICT",
					`Income source code '${normalizedCode}' already exists with different activeUntil`,
				);
			}

			return {
				incomeSource: {
					id: existing.id,
					userId: existing.userId,
					code: existing.code,
					name: existing.name,
					nature: existing.nature as IncomeSourceItem["nature"],
					referenceMethod:
						existing.referenceMethod as IncomeSourceItem["referenceMethod"],
					expectedMonthlyAmount: existing.expectedMonthlyAmount,
					seasonalMonthsPerYear: existing.seasonalMonthsPerYear,
					rollingMedianMonths: existing.rollingMedianMonths,
					incomeLedgerAccountId: existing.incomeLedgerAccountId,
					activeFrom: existing.activeFrom,
					activeUntil: existing.activeUntil,
					createdAt: existing.createdAt,
					archivedAt: existing.archivedAt,
				},
				idempotentReplay: true,
			};
		}

		throw err;
	}
}

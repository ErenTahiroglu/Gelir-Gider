import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/auth";
import {
	monthlyBudgetPlanRevisions,
	monthlyBudgetPlans,
} from "../db/schema/budget";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../db/schema/transactions";
import { getIstanbulDateAtMidnightUtc } from "../income/calendar";
import { IncomeError } from "../income/errors";
import { getMonthlyReferenceIncome } from "../income/reference";
import {
	createCanonicalTransactionInTransaction,
	reviseCanonicalTransactionInTransaction,
	type TransactionSourceInput,
	voidCanonicalTransactionInTransaction,
} from "../transactions/service";
import { BudgetError } from "./errors";
import {
	allocatePersonalBudgetV1,
	PERSONAL_BUDGET_V1,
	type PersonalBudgetV1Result,
} from "./policy";
import {
	isBudgetPeriodUniqueViolation,
	mapCanonicalError,
	normalizeUuid,
	validateBudgetPeriodMonth,
} from "./utils";

export type BudgetPlanStatus = "ACTIVE" | "VOIDED";

export interface BudgetComponentOutput {
	role: "CEILING" | "TARGET";
	basisPoints: number;
	amount: string;
}

export interface MonthlyBudgetPlanItem {
	budgetPlanId: string;
	periodMonth: string;
	status: BudgetPlanStatus;
	revisionNo: number;
	policyVersion: string;
	currency: string;
	referenceIncome: string;
	referenceSnapshot: Record<string, unknown>;

	mandatoryExpense: BudgetComponentOutput;
	discretionarySpend: BudgetComponentOutput;
	shortTermPurchase: BudgetComponentOutput;
	mediumTermReserve: BudgetComponentOutput;
	longTermInvestment: BudgetComponentOutput;

	canonicalTransactionId: string;
	canonicalRevisionId: string;
}

export interface CreateMonthlyBudgetPlanParams {
	db: Database;
	userId: string;
	periodMonth: string;
	idempotencyKey: string;
	provenance: TransactionSourceInput;
}

export interface CreateMonthlyBudgetPlanResult {
	budgetPlan: MonthlyBudgetPlanItem;
	idempotentReplay: boolean;
}

export interface RefreshMonthlyBudgetPlanParams {
	db: Database;
	userId: string;
	budgetPlanId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface RefreshMonthlyBudgetPlanResult {
	budgetPlan: MonthlyBudgetPlanItem;
	idempotentReplay: boolean;
}

export interface VoidMonthlyBudgetPlanParams {
	db: Database;
	userId: string;
	budgetPlanId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface VoidMonthlyBudgetPlanResult {
	budgetPlan: MonthlyBudgetPlanItem;
	idempotentReplay: boolean;
}

export interface GetMonthlyBudgetPlanParams {
	db: Database;
	userId: string;
	budgetPlanId?: string | undefined;
	periodMonth?: string | undefined;
}

export interface ListMonthlyBudgetPlansParams {
	db: Database;
	userId: string;
	periodMonthFrom?: string | undefined;
	periodMonthUntil?: string | undefined;
}

function formatBudgetPlanItem(
	plan: typeof monthlyBudgetPlans.$inferSelect,
	rev: typeof monthlyBudgetPlanRevisions.$inferSelect,
): MonthlyBudgetPlanItem {
	return {
		budgetPlanId: plan.id,
		periodMonth: plan.periodMonth,
		status: rev.operation === "VOID" ? "VOIDED" : "ACTIVE",
		revisionNo: rev.revisionNo,
		policyVersion: rev.policyVersion,
		currency: rev.currency,
		referenceIncome: rev.referenceIncomeAmount,
		referenceSnapshot: rev.referenceSnapshot as Record<string, unknown>,

		mandatoryExpense: {
			role: "CEILING",
			basisPoints: 6500,
			amount: rev.mandatoryCeilingAmount,
		},
		discretionarySpend: {
			role: "CEILING",
			basisPoints: 500,
			amount: rev.discretionaryCeilingAmount,
		},
		shortTermPurchase: {
			role: "TARGET",
			basisPoints: 1000,
			amount: rev.shortTermPurchaseAmount,
		},
		mediumTermReserve: {
			role: "TARGET",
			basisPoints: 1000,
			amount: rev.mediumTermReserveAmount,
		},
		longTermInvestment: {
			role: "TARGET",
			basisPoints: 1000,
			amount: rev.longTermInvestmentAmount,
		},

		canonicalTransactionId: plan.canonicalTransactionId,
		canonicalRevisionId: rev.canonicalRevisionId,
	};
}

function buildCanonicalPayload(
	periodMonth: string,
	currency: string,
	allocRes: PersonalBudgetV1Result,
	referenceSnapshot: Record<string, unknown>,
): Record<string, unknown> {
	return {
		periodMonth,
		policyVersion: PERSONAL_BUDGET_V1,
		currency,
		referenceIncome: allocRes.referenceIncome,
		referenceSnapshot,
		allocations: {
			MANDATORY_EXPENSE: {
				basisPoints: 6500,
				role: "CEILING",
				amount: allocRes.allocations.MANDATORY_EXPENSE.amount,
			},
			DISCRETIONARY_SPEND: {
				basisPoints: 500,
				role: "CEILING",
				amount: allocRes.allocations.DISCRETIONARY_SPEND.amount,
			},
			SHORT_TERM_PURCHASE: {
				basisPoints: 1000,
				role: "TARGET",
				amount: allocRes.allocations.SHORT_TERM_PURCHASE.amount,
			},
			MEDIUM_TERM_RESERVE: {
				basisPoints: 1000,
				role: "TARGET",
				amount: allocRes.allocations.MEDIUM_TERM_RESERVE.amount,
			},
			LONG_TERM_INVESTMENT: {
				basisPoints: 1000,
				role: "TARGET",
				amount: allocRes.allocations.LONG_TERM_INVESTMENT.amount,
			},
		},
	};
}

/**
 * Creates a new monthly budget plan.
 * Implements historical idempotency first: if the idempotency key was previously
 * used for creation, calls the canonical service with the stored payload/occurredAt
 * to validate the fingerprint before returning the stored plan.
 */
export async function createMonthlyBudgetPlan(
	params: CreateMonthlyBudgetPlanParams,
): Promise<CreateMonthlyBudgetPlanResult> {
	const { db, userId, periodMonth, idempotencyKey, provenance } = params;

	if (!userId || userId.trim() === "") {
		throw new BudgetError("BUDGET_INVALID_INPUT", "User ID is required");
	}

	// Defect H: validateBudgetPeriodMonth maps IncomeError -> BudgetError
	const validPeriod = validateBudgetPeriodMonth(periodMonth);

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	// 1. HISTORICAL IDEMPOTENCY CHECK FIRST (before fresh transaction)
	// Check if a canonical transaction already exists with this creation idempotency key.
	const [existingCanon] = await db
		.select()
		.from(canonicalTransactions)
		.where(
			and(
				eq(canonicalTransactions.userId, userId),
				eq(canonicalTransactions.creationIdempotencyKey, trimmedIdempotencyKey),
			),
		)
		.limit(1);

	if (existingCanon) {
		if (existingCanon.kind !== "MONTHLY_BUDGET_PLAN") {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${trimmedIdempotencyKey}" already used for kind "${existingCanon.kind}"`,
			);
		}

		// Load plan identity
		const [plan] = await db
			.select()
			.from(monthlyBudgetPlans)
			.where(
				and(
					eq(monthlyBudgetPlans.canonicalTransactionId, existingCanon.id),
					eq(monthlyBudgetPlans.userId, userId),
				),
			)
			.limit(1);

		if (!plan) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Corrupted state: canonical transaction exists but monthly budget plan is missing",
			);
		}

		if (plan.periodMonth !== validPeriod) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${trimmedIdempotencyKey}" was previously used for period "${plan.periodMonth}", cannot reuse for "${validPeriod}"`,
			);
		}

		// Load budget revision #1
		const [rev1] = await db
			.select()
			.from(monthlyBudgetPlanRevisions)
			.where(
				and(
					eq(monthlyBudgetPlanRevisions.budgetPlanId, plan.id),
					eq(monthlyBudgetPlanRevisions.userId, userId),
					eq(monthlyBudgetPlanRevisions.revisionNo, 1),
				),
			)
			.limit(1);

		if (!rev1) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Corrupted state: budget plan revision #1 is missing",
			);
		}

		// Load stored canonical revision #1 for payload + occurredAt
		const [storedCanonRev] = await db
			.select()
			.from(transactionRevisions)
			.where(
				and(
					eq(transactionRevisions.transactionId, existingCanon.id),
					eq(transactionRevisions.revisionNo, 1),
				),
			)
			.limit(1);

		if (!storedCanonRev) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Corrupted state: canonical revision #1 is missing",
			);
		}

		// Validate historical linkage integrity
		if (
			rev1.canonicalRevisionId !== storedCanonRev.id ||
			storedCanonRev.revisionNo !== 1 ||
			storedCanonRev.operation !== "CREATE"
		) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Historical budget plan revision linkage is inconsistent with canonical revision",
			);
		}

		// Defect B: Run canonical fingerprint validation with stored payload/occurredAt.
		// This ensures changed provenance is rejected with BUDGET_IDEMPOTENCY_CONFLICT.
		// Reference income is NOT recomputed.
		return await db.transaction(async (tx) => {
			try {
				const canonRes = await createCanonicalTransactionInTransaction({
					tx,
					userId,
					kind: "MONTHLY_BUDGET_PLAN",
					idempotencyKey: trimmedIdempotencyKey,
					occurredAt: storedCanonRev.occurredAt,
					payload: storedCanonRev.payload as Record<string, unknown>,
					source: provenance,
				});

				if (!canonRes.idempotentReplay) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Expected canonical idempotent replay but got fresh creation",
					);
				}

				// Validate projection consistency
				if (
					plan.canonicalTransactionId !== canonRes.transactionId ||
					rev1.canonicalRevisionId !== canonRes.revisionId
				) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Historical budget plan projection does not match canonical replay result",
					);
				}

				return {
					budgetPlan: formatBudgetPlanItem(plan, rev1),
					idempotentReplay: true,
				};
			} catch (err: unknown) {
				mapCanonicalError(err);
			}
		});
	}

	// 2. FRESH PLAN CREATION (in 1 outer transaction with REPEATABLE READ isolation)
	// Defect E: REPEATABLE READ ensures getMonthlyReferenceIncome sees a consistent snapshot.
	const occurredAt = getIstanbulDateAtMidnightUtc(validPeriod);

	return await db.transaction(
		async (tx) => {
			// Fetch user for currency
			const [user] = await tx
				.select({ currency: users.currency })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);

			if (!user) {
				throw new BudgetError("BUDGET_INVALID_INPUT", "User not found");
			}

			// Check if a plan already exists for this period
			const [existingPlan] = await tx
				.select()
				.from(monthlyBudgetPlans)
				.where(
					and(
						eq(monthlyBudgetPlans.userId, userId),
						eq(monthlyBudgetPlans.periodMonth, validPeriod),
					),
				)
				.limit(1);

			if (existingPlan) {
				throw new BudgetError(
					"BUDGET_PERIOD_CONFLICT",
					`Monthly budget plan already exists for period "${validPeriod}"`,
				);
			}

			// Defect H: Map reference engine failures to BUDGET_REFERENCE_INVALID_STATE
			let refIncome: Awaited<ReturnType<typeof getMonthlyReferenceIncome>>;
			try {
				refIncome = await getMonthlyReferenceIncome({
					db: tx,
					userId,
					asOf: validPeriod,
				});
			} catch (err: unknown) {
				if (err instanceof IncomeError) {
					throw new BudgetError(
						"BUDGET_REFERENCE_INVALID_STATE",
						`Reference income calculation failed: ${err.message}`,
					);
				}
				throw err;
			}

			const normalizedSnapshot: Record<string, unknown> = {
				asOf: refIncome.asOf,
				currency: refIncome.currency,
				total: refIncome.total,
				sources: refIncome.sources.map((s) => ({
					sourceId: s.sourceId,
					code: s.code,
					name: s.name,
					nature: s.nature,
					referenceMethod: s.referenceMethod,
					referenceAmount: s.referenceAmount,
				})),
			};

			const allocRes = allocatePersonalBudgetV1(refIncome.total);
			const canonicalPayload = buildCanonicalPayload(
				validPeriod,
				refIncome.currency,
				allocRes,
				normalizedSnapshot,
			);

			// Create canonical transaction; map canonical errors
			let canonRes: Awaited<
				ReturnType<typeof createCanonicalTransactionInTransaction>
			>;
			try {
				canonRes = await createCanonicalTransactionInTransaction({
					tx,
					userId,
					kind: "MONTHLY_BUDGET_PLAN",
					idempotencyKey: trimmedIdempotencyKey,
					occurredAt,
					payload: canonicalPayload,
					source: provenance,
				});
			} catch (err: unknown) {
				mapCanonicalError(err);
			}

			if (canonRes.idempotentReplay) {
				const [existingPlanReplay] = await tx
					.select()
					.from(monthlyBudgetPlans)
					.where(
						and(
							eq(
								monthlyBudgetPlans.canonicalTransactionId,
								canonRes.transactionId,
							),
							eq(monthlyBudgetPlans.userId, userId),
						),
					)
					.limit(1);

				if (!existingPlanReplay) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Canonical transaction replay succeeded but budget plan row missing",
					);
				}

				const [existingRevReplay] = await tx
					.select()
					.from(monthlyBudgetPlanRevisions)
					.where(
						and(
							eq(
								monthlyBudgetPlanRevisions.budgetPlanId,
								existingPlanReplay.id,
							),
							eq(monthlyBudgetPlanRevisions.userId, userId),
							eq(monthlyBudgetPlanRevisions.revisionNo, 1),
						),
					)
					.limit(1);

				if (!existingRevReplay) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Budget plan revision #1 missing on replay",
					);
				}

				return {
					budgetPlan: formatBudgetPlanItem(
						existingPlanReplay,
						existingRevReplay,
					),
					idempotentReplay: true,
				};
			}

			// Insert plan identity
			let createdPlan: typeof monthlyBudgetPlans.$inferSelect | undefined;
			try {
				const [inserted] = await tx
					.insert(monthlyBudgetPlans)
					.values({
						userId,
						periodMonth: validPeriod,
						canonicalTransactionId: canonRes.transactionId,
					})
					.returning();
				createdPlan = inserted;
			} catch (err: unknown) {
				if (isBudgetPeriodUniqueViolation(err)) {
					throw new BudgetError(
						"BUDGET_PERIOD_CONFLICT",
						`Monthly budget plan already exists for period "${validPeriod}"`,
					);
				}
				throw err;
			}

			if (!createdPlan) {
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					"Failed to create monthly budget plan identity",
				);
			}

			// Insert revision #1
			const [createdRev] = await tx
				.insert(monthlyBudgetPlanRevisions)
				.values({
					userId,
					budgetPlanId: createdPlan.id,
					canonicalRevisionId: canonRes.revisionId,
					revisionNo: 1,
					previousBudgetRevisionId: null,
					operation: "CREATE",
					policyVersion: PERSONAL_BUDGET_V1,
					currency: refIncome.currency,
					referenceIncomeAmount: allocRes.referenceIncome,
					mandatoryCeilingAmount: allocRes.allocations.MANDATORY_EXPENSE.amount,
					discretionaryCeilingAmount:
						allocRes.allocations.DISCRETIONARY_SPEND.amount,
					shortTermPurchaseAmount:
						allocRes.allocations.SHORT_TERM_PURCHASE.amount,
					mediumTermReserveAmount:
						allocRes.allocations.MEDIUM_TERM_RESERVE.amount,
					longTermInvestmentAmount:
						allocRes.allocations.LONG_TERM_INVESTMENT.amount,
					referenceSnapshot: normalizedSnapshot,
				})
				.returning();

			if (!createdRev) {
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					"Failed to insert budget plan revision #1",
				);
			}

			return {
				budgetPlan: formatBudgetPlanItem(createdPlan, createdRev),
				idempotentReplay: false,
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}

/**
 * Refreshes / recalculates a monthly budget plan based on current reference income.
 * Appends an UPDATE revision.
 * Defect C: Idempotency replay check is FIRST — before VOID guard — and calls
 * reviseCanonicalTransactionInTransaction with stored payload/occurredAt to validate fingerprint.
 * Defect E: REPEATABLE READ for fresh refresh path.
 */
export async function refreshMonthlyBudgetPlan(
	params: RefreshMonthlyBudgetPlanParams,
): Promise<RefreshMonthlyBudgetPlanResult> {
	const {
		db,
		userId,
		budgetPlanId,
		expectedRevisionNo,
		idempotencyKey,
		reasonCode,
		reasonNote,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new BudgetError("BUDGET_INVALID_INPUT", "User ID is required");
	}

	const canonicalPlanId = normalizeUuid(budgetPlanId, "budgetPlanId");

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	const trimmedReasonCode = reasonCode?.trim();
	if (!trimmedReasonCode) {
		throw new BudgetError("BUDGET_INVALID_INPUT", "Reason code is required");
	}

	return await db.transaction(
		async (tx) => {
			// 1. Lock/resolve budget plan identity
			const [plan] = await tx
				.select()
				.from(monthlyBudgetPlans)
				.where(
					and(
						eq(monthlyBudgetPlans.id, canonicalPlanId),
						eq(monthlyBudgetPlans.userId, userId),
					),
				)
				.for("update")
				.limit(1);

			if (!plan) {
				throw new BudgetError(
					"BUDGET_PLAN_NOT_FOUND",
					`Monthly budget plan "${canonicalPlanId}" not found`,
				);
			}

			// 2. Defect C: HISTORICAL IDEMPOTENCY CHECK FIRST (before VOID guard, before reference recomputation)
			const [existingCanonRev] = await tx
				.select()
				.from(transactionRevisions)
				.where(
					and(
						eq(transactionRevisions.transactionId, plan.canonicalTransactionId),
						eq(transactionRevisions.idempotencyKey, trimmedIdempotencyKey),
						eq(transactionRevisions.operation, "UPDATE"),
					),
				)
				.limit(1);

			if (existingCanonRev) {
				let canonRes: Awaited<
					ReturnType<typeof reviseCanonicalTransactionInTransaction>
				>;
				try {
					canonRes = await reviseCanonicalTransactionInTransaction({
						tx,
						userId,
						transactionId: plan.canonicalTransactionId,
						expectedRevisionNo: existingCanonRev.revisionNo - 1,
						idempotencyKey: trimmedIdempotencyKey,
						occurredAt: existingCanonRev.occurredAt,
						payload: existingCanonRev.payload as Record<string, unknown>,
						reasonCode: trimmedReasonCode,
						reasonNote,
						source: provenance,
					});
				} catch (err: unknown) {
					mapCanonicalError(err);
				}

				if (!canonRes.idempotentReplay) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Expected canonical idempotent replay but got fresh revision",
					);
				}

				const [storedPlanRev] = await tx
					.select()
					.from(monthlyBudgetPlanRevisions)
					.where(
						and(
							eq(
								monthlyBudgetPlanRevisions.canonicalRevisionId,
								canonRes.revisionId,
							),
							eq(monthlyBudgetPlanRevisions.userId, userId),
						),
					)
					.limit(1);

				if (!storedPlanRev) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Idempotent refresh replay: budget plan revision row missing",
					);
				}

				if (
					plan.canonicalTransactionId !== canonRes.transactionId ||
					storedPlanRev.canonicalRevisionId !== canonRes.revisionId ||
					storedPlanRev.revisionNo !== canonRes.revisionNo ||
					storedPlanRev.operation !== canonRes.operation
				) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Historical budget plan projection does not match canonical replay result",
					);
				}

				return {
					budgetPlan: formatBudgetPlanItem(plan, storedPlanRev),
					idempotentReplay: true,
				};
			}

			// 3. FRESH REFRESH: fetch authoritative latest revision
			const [latestRev] = await tx
				.select()
				.from(monthlyBudgetPlanRevisions)
				.where(
					and(
						eq(monthlyBudgetPlanRevisions.budgetPlanId, plan.id),
						eq(monthlyBudgetPlanRevisions.userId, userId),
					),
				)
				.orderBy(desc(monthlyBudgetPlanRevisions.revisionNo))
				.limit(1);

			if (!latestRev) {
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					"Monthly budget plan has no revisions",
				);
			}

			if (latestRev.operation === "VOID") {
				throw new BudgetError(
					"BUDGET_ALREADY_VOIDED",
					`Cannot refresh VOIDED monthly budget plan "${plan.id}"`,
				);
			}

			if (latestRev.revisionNo !== expectedRevisionNo) {
				throw new BudgetError(
					"BUDGET_REVISION_CONFLICT",
					`Expected revision ${expectedRevisionNo}, but latest revision is ${latestRev.revisionNo}`,
				);
			}

			// 4. Recompute reference income for the plan's period (Defect H: error boundary)
			let refIncome: Awaited<ReturnType<typeof getMonthlyReferenceIncome>>;
			try {
				refIncome = await getMonthlyReferenceIncome({
					db: tx,
					userId,
					asOf: plan.periodMonth,
				});
			} catch (err: unknown) {
				if (err instanceof IncomeError) {
					throw new BudgetError(
						"BUDGET_REFERENCE_INVALID_STATE",
						`Reference income calculation failed: ${err.message}`,
					);
				}
				throw err;
			}

			const normalizedSnapshot: Record<string, unknown> = {
				asOf: refIncome.asOf,
				currency: refIncome.currency,
				total: refIncome.total,
				sources: refIncome.sources.map((s) => ({
					sourceId: s.sourceId,
					code: s.code,
					name: s.name,
					nature: s.nature,
					referenceMethod: s.referenceMethod,
					referenceAmount: s.referenceAmount,
				})),
			};

			const allocRes = allocatePersonalBudgetV1(refIncome.total);
			const canonicalPayload = buildCanonicalPayload(
				plan.periodMonth,
				refIncome.currency,
				allocRes,
				normalizedSnapshot,
			);

			const occurredAt = getIstanbulDateAtMidnightUtc(plan.periodMonth);

			// 5. Revise canonical transaction (Defect H: canonical error boundary)
			let canonRes: Awaited<
				ReturnType<typeof reviseCanonicalTransactionInTransaction>
			>;
			try {
				canonRes = await reviseCanonicalTransactionInTransaction({
					tx,
					userId,
					transactionId: plan.canonicalTransactionId,
					expectedRevisionNo,
					idempotencyKey: trimmedIdempotencyKey,
					occurredAt,
					payload: canonicalPayload,
					reasonCode: trimmedReasonCode,
					reasonNote,
					source: provenance,
				});
			} catch (err: unknown) {
				mapCanonicalError(err);
			}

			if (canonRes.idempotentReplay) {
				const [storedPlanRev] = await tx
					.select()
					.from(monthlyBudgetPlanRevisions)
					.where(
						and(
							eq(
								monthlyBudgetPlanRevisions.canonicalRevisionId,
								canonRes.revisionId,
							),
							eq(monthlyBudgetPlanRevisions.userId, userId),
						),
					)
					.limit(1);

				if (storedPlanRev) {
					return {
						budgetPlan: formatBudgetPlanItem(plan, storedPlanRev),
						idempotentReplay: true,
					};
				}
			}

			// 6. Insert new revision
			const [newRev] = await tx
				.insert(monthlyBudgetPlanRevisions)
				.values({
					userId,
					budgetPlanId: plan.id,
					canonicalRevisionId: canonRes.revisionId,
					revisionNo: expectedRevisionNo + 1,
					previousBudgetRevisionId: latestRev.id,
					operation: "UPDATE",
					policyVersion: PERSONAL_BUDGET_V1,
					currency: refIncome.currency,
					referenceIncomeAmount: allocRes.referenceIncome,
					mandatoryCeilingAmount: allocRes.allocations.MANDATORY_EXPENSE.amount,
					discretionaryCeilingAmount:
						allocRes.allocations.DISCRETIONARY_SPEND.amount,
					shortTermPurchaseAmount:
						allocRes.allocations.SHORT_TERM_PURCHASE.amount,
					mediumTermReserveAmount:
						allocRes.allocations.MEDIUM_TERM_RESERVE.amount,
					longTermInvestmentAmount:
						allocRes.allocations.LONG_TERM_INVESTMENT.amount,
					referenceSnapshot: normalizedSnapshot,
				})
				.returning();

			if (!newRev) {
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					"Failed to insert updated budget plan revision",
				);
			}

			return {
				budgetPlan: formatBudgetPlanItem(plan, newRev),
				idempotentReplay: false,
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}

/**
 * Voids a monthly budget plan.
 * Appends a VOID revision copying predecessor values exactly.
 * Defect D: Manual VOID replay check removed — voidCanonicalTransactionInTransaction
 * handles idempotency + fingerprint validation directly.
 */
export async function voidMonthlyBudgetPlan(
	params: VoidMonthlyBudgetPlanParams,
): Promise<VoidMonthlyBudgetPlanResult> {
	const {
		db,
		userId,
		budgetPlanId,
		expectedRevisionNo,
		idempotencyKey,
		reasonCode,
		reasonNote,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new BudgetError("BUDGET_INVALID_INPUT", "User ID is required");
	}

	const canonicalPlanId = normalizeUuid(budgetPlanId, "budgetPlanId");

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	const trimmedReasonCode = reasonCode?.trim();
	if (!trimmedReasonCode) {
		throw new BudgetError("BUDGET_INVALID_INPUT", "Reason code is required");
	}

	return await db.transaction(async (tx) => {
		// 1. Lock budget plan identity
		const [plan] = await tx
			.select()
			.from(monthlyBudgetPlans)
			.where(
				and(
					eq(monthlyBudgetPlans.id, canonicalPlanId),
					eq(monthlyBudgetPlans.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		if (!plan) {
			throw new BudgetError(
				"BUDGET_PLAN_NOT_FOUND",
				`Monthly budget plan "${canonicalPlanId}" not found`,
			);
		}

		// 2. Fetch authoritative latest revision
		const [latestRev] = await tx
			.select()
			.from(monthlyBudgetPlanRevisions)
			.where(
				and(
					eq(monthlyBudgetPlanRevisions.budgetPlanId, plan.id),
					eq(monthlyBudgetPlanRevisions.userId, userId),
				),
			)
			.orderBy(desc(monthlyBudgetPlanRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Monthly budget plan has no revisions",
			);
		}

		// 3. Append canonical VOID revision
		// Defect D: voidCanonicalTransactionInTransaction handles both:
		//   - idempotent replay (same key + same fingerprint) -> returns idempotentReplay: true
		//   - changed reasonCode/provenance -> raises TRANSACTION_IDEMPOTENCY_CONFLICT
		//   - plan already voided -> raises TRANSACTION_ALREADY_VOIDED
		//   - revision conflict -> raises TRANSACTION_REVISION_CONFLICT
		let canonRes: Awaited<
			ReturnType<typeof voidCanonicalTransactionInTransaction>
		>;
		try {
			canonRes = await voidCanonicalTransactionInTransaction({
				tx,
				userId,
				transactionId: plan.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey: trimmedIdempotencyKey,
				reasonCode: trimmedReasonCode,
				reasonNote,
				source: provenance,
			});
		} catch (err: unknown) {
			mapCanonicalError(err);
		}

		if (canonRes.idempotentReplay) {
			const [storedPlanRev] = await tx
				.select()
				.from(monthlyBudgetPlanRevisions)
				.where(
					and(
						eq(
							monthlyBudgetPlanRevisions.canonicalRevisionId,
							canonRes.revisionId,
						),
						eq(monthlyBudgetPlanRevisions.userId, userId),
					),
				)
				.limit(1);

			if (storedPlanRev) {
				return {
					budgetPlan: formatBudgetPlanItem(plan, storedPlanRev),
					idempotentReplay: true,
				};
			}
		}

		// latestRev must still be the predecessor (not voided) for us to proceed
		if (latestRev.operation === "VOID") {
			throw new BudgetError(
				"BUDGET_ALREADY_VOIDED",
				`Monthly budget plan "${plan.id}" is already VOIDED`,
			);
		}

		// 4. Insert new VOID revision
		const [newRev] = await tx
			.insert(monthlyBudgetPlanRevisions)
			.values({
				userId,
				budgetPlanId: plan.id,
				canonicalRevisionId: canonRes.revisionId,
				revisionNo: expectedRevisionNo + 1,
				previousBudgetRevisionId: latestRev.id,
				operation: "VOID",
				policyVersion: latestRev.policyVersion,
				currency: latestRev.currency,
				referenceIncomeAmount: latestRev.referenceIncomeAmount,
				mandatoryCeilingAmount: latestRev.mandatoryCeilingAmount,
				discretionaryCeilingAmount: latestRev.discretionaryCeilingAmount,
				shortTermPurchaseAmount: latestRev.shortTermPurchaseAmount,
				mediumTermReserveAmount: latestRev.mediumTermReserveAmount,
				longTermInvestmentAmount: latestRev.longTermInvestmentAmount,
				referenceSnapshot: latestRev.referenceSnapshot,
			})
			.returning();

		if (!newRev) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Failed to insert void budget plan revision",
			);
		}

		return {
			budgetPlan: formatBudgetPlanItem(plan, newRev),
			idempotentReplay: false,
		};
	});
}

/**
 * Retrieves a single monthly budget plan by ID or period month.
 */
export async function getMonthlyBudgetPlan(
	params: GetMonthlyBudgetPlanParams,
): Promise<MonthlyBudgetPlanItem> {
	const { db, userId, budgetPlanId, periodMonth } = params;

	if (!userId || userId.trim() === "") {
		throw new BudgetError("BUDGET_INVALID_INPUT", "User ID is required");
	}

	if (!budgetPlanId && !periodMonth) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Either budgetPlanId or periodMonth is required",
		);
	}

	const conditions = [eq(monthlyBudgetPlans.userId, userId)];

	if (budgetPlanId) {
		const canonicalPlanId = normalizeUuid(budgetPlanId, "budgetPlanId");
		conditions.push(eq(monthlyBudgetPlans.id, canonicalPlanId));
	}

	if (periodMonth) {
		// Defect H: validateBudgetPeriodMonth maps IncomeError -> BudgetError
		const validPeriod = validateBudgetPeriodMonth(periodMonth);
		conditions.push(eq(monthlyBudgetPlans.periodMonth, validPeriod));
	}

	const [plan] = await db
		.select()
		.from(monthlyBudgetPlans)
		.where(and(...conditions))
		.limit(1);

	if (!plan) {
		throw new BudgetError(
			"BUDGET_PLAN_NOT_FOUND",
			budgetPlanId
				? `Monthly budget plan "${budgetPlanId}" not found`
				: `Monthly budget plan for period "${periodMonth}" not found`,
		);
	}

	const [latestRev] = await db
		.select()
		.from(monthlyBudgetPlanRevisions)
		.where(
			and(
				eq(monthlyBudgetPlanRevisions.budgetPlanId, plan.id),
				eq(monthlyBudgetPlanRevisions.userId, userId),
			),
		)
		.orderBy(desc(monthlyBudgetPlanRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new BudgetError(
			"BUDGET_INVALID_STATE",
			"Monthly budget plan has no revisions",
		);
	}

	return formatBudgetPlanItem(plan, latestRev);
}

/**
 * Lists monthly budget plans for a user without N+1 queries.
 * Ordered deterministically by periodMonth DESC, id ASC.
 */
export async function listMonthlyBudgetPlans(
	params: ListMonthlyBudgetPlansParams,
): Promise<MonthlyBudgetPlanItem[]> {
	const { db, userId, periodMonthFrom, periodMonthUntil } = params;

	if (!userId || userId.trim() === "") {
		throw new BudgetError("BUDGET_INVALID_INPUT", "User ID is required");
	}

	const conditions = [eq(monthlyBudgetPlans.userId, userId)];

	// Defect G: Use gte/lte range operators, not equality.
	// Defect H: validateBudgetPeriodMonth maps IncomeError -> BudgetError.
	let validFrom: string | undefined;
	let validUntil: string | undefined;

	if (periodMonthFrom && periodMonthFrom.trim() !== "") {
		validFrom = validateBudgetPeriodMonth(periodMonthFrom);
		conditions.push(gte(monthlyBudgetPlans.periodMonth, validFrom));
	}

	if (periodMonthUntil && periodMonthUntil.trim() !== "") {
		validUntil = validateBudgetPeriodMonth(periodMonthUntil);
		conditions.push(lte(monthlyBudgetPlans.periodMonth, validUntil));
	}

	// Cross-range validation: from must be <= until
	if (
		validFrom !== undefined &&
		validUntil !== undefined &&
		validFrom > validUntil
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`periodMonthFrom "${validFrom}" must not be after periodMonthUntil "${validUntil}"`,
		);
	}

	const plans = await db
		.select()
		.from(monthlyBudgetPlans)
		.where(and(...conditions))
		.orderBy(desc(monthlyBudgetPlans.periodMonth), monthlyBudgetPlans.id);

	if (plans.length === 0) {
		return [];
	}

	const planIds = plans.map((p) => p.id);

	// Fetch all revisions for these plans, ordered by revisionNo DESC
	const allRevs = await db
		.select()
		.from(monthlyBudgetPlanRevisions)
		.where(
			and(
				eq(monthlyBudgetPlanRevisions.userId, userId),
				inArray(monthlyBudgetPlanRevisions.budgetPlanId, planIds),
			),
		)
		.orderBy(desc(monthlyBudgetPlanRevisions.revisionNo));

	const latestRevsMap = new Map<
		string,
		typeof monthlyBudgetPlanRevisions.$inferSelect
	>();
	for (const rev of allRevs) {
		if (!latestRevsMap.has(rev.budgetPlanId)) {
			latestRevsMap.set(rev.budgetPlanId, rev);
		}
	}

	const result: MonthlyBudgetPlanItem[] = [];
	for (const plan of plans) {
		const latestRev = latestRevsMap.get(plan.id);
		if (latestRev) {
			result.push(formatBudgetPlanItem(plan, latestRev));
		}
	}

	return result;
}

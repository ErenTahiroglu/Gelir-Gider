import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/auth";
import {
	monthlyBudgetV2PlanRevisions,
	monthlyBudgetV2Plans,
} from "../db/schema/budget-v2";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../db/schema/transactions";
import { getIstanbulDateAtMidnightUtc } from "../income/calendar";
import { canonicalizePayload } from "../transactions/canonical-json";
import {
	createCanonicalTransactionInTransaction,
	reviseCanonicalTransactionInTransaction,
	type TransactionSourceInput,
	voidCanonicalTransactionInTransaction,
} from "../transactions/service";
import { BudgetError } from "./errors";
import {
	type BudgetV2ResolvedSnapshot,
	buildBudgetV2CanonicalPayload,
	validateBudgetV2ResolvedSnapshot,
} from "./payload-v2";
import { PERSONAL_BUDGET_V2 } from "./policy-v2";
import {
	isBudgetV2PeriodUniqueViolation,
	mapCanonicalError,
	normalizeUuid,
	validateBudgetPeriodMonth,
} from "./utils";

export const BUDGET_V2_CANONICAL_KIND = "MONTHLY_BUDGET_PLAN_V2" as const;

// ============================================================================
// Read model
// ============================================================================

export type BudgetV2PlanStatus = "ACTIVE" | "VOIDED";

export interface BudgetV2InputAmounts {
	realizedIncome: string;
	currentObligations: string;
	basicLivingFunding: string;
	dateBoundNecessaryPurchaseFunding: string;
	coreEmergencyFundBalance: string;
	mobilityBalance: string;
}

export interface BudgetV2OutputAmounts {
	emergencyCatchUp: string;
	deficit: string;
	trueSurplus: string;
	mobilityAllocation: string;
	longTermInvestment: string;
	discretionaryAllocation: string;
}

export interface MonthlyBudgetV2PlanItem {
	budgetPlanId: string;
	periodMonth: string;
	status: BudgetV2PlanStatus;
	revisionNo: number;
	policyVersion: string;
	currency: string;
	inputs: BudgetV2InputAmounts;
	outputs: BudgetV2OutputAmounts;
	evidenceSnapshot: Record<string, unknown>;
	canonicalTransactionId: string;
	canonicalRevisionId: string;
}

function formatV2Item(
	plan: typeof monthlyBudgetV2Plans.$inferSelect,
	rev: typeof monthlyBudgetV2PlanRevisions.$inferSelect,
): MonthlyBudgetV2PlanItem {
	return {
		budgetPlanId: plan.id,
		periodMonth: plan.periodMonth,
		status: rev.operation === "VOID" ? "VOIDED" : "ACTIVE",
		revisionNo: rev.revisionNo,
		policyVersion: rev.policyVersion,
		currency: rev.currency,
		inputs: {
			realizedIncome: rev.realizedIncomeAmount,
			currentObligations: rev.currentObligationsAmount,
			basicLivingFunding: rev.basicLivingFundingAmount,
			dateBoundNecessaryPurchaseFunding:
				rev.dateBoundNecessaryPurchaseFundingAmount,
			coreEmergencyFundBalance: rev.coreEmergencyFundBalanceAmount,
			mobilityBalance: rev.mobilityBalanceAmount,
		},
		outputs: {
			emergencyCatchUp: rev.emergencyCatchUpAmount,
			deficit: rev.deficitAmount,
			trueSurplus: rev.trueSurplusAmount,
			mobilityAllocation: rev.mobilityAllocationAmount,
			longTermInvestment: rev.longTermInvestmentAmount,
			discretionaryAllocation: rev.discretionaryAllocationAmount,
		},
		evidenceSnapshot: rev.evidenceSnapshot as Record<string, unknown>,
		canonicalTransactionId: plan.canonicalTransactionId,
		canonicalRevisionId: rev.canonicalRevisionId,
	};
}

/** Deterministic canonical-JSON string for exact payload equality checks. */
function canonicalJsonOf(payload: unknown): string {
	return canonicalizePayload(payload).canonicalJson;
}

// ============================================================================
// Params / results
// ============================================================================

export interface CreateMonthlyBudgetV2PlanParams {
	db: Database;
	userId: string;
	periodMonth: string;
	idempotencyKey: string;
	/**
	 * ALREADY-RESOLVED trusted snapshot. This low-level writer never queries
	 * live Income / Cards / People / Goals. A future source resolver MUST check
	 * historical replay (via this same idempotency key) BEFORE recomputing
	 * mutable current sources, because this writer is deliberately strict: a
	 * replay whose supplied snapshot differs from the stored creation snapshot
	 * is an idempotency conflict, not a silent re-creation.
	 */
	resolvedSnapshot: BudgetV2ResolvedSnapshot;
	provenance: TransactionSourceInput;
}

export interface CreateMonthlyBudgetV2PlanResult {
	budgetPlan: MonthlyBudgetV2PlanItem;
	idempotentReplay: boolean;
}

export interface RefreshMonthlyBudgetV2PlanParams {
	db: Database;
	userId: string;
	budgetPlanId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	resolvedSnapshot: BudgetV2ResolvedSnapshot;
	provenance: TransactionSourceInput;
}

export interface RefreshMonthlyBudgetV2PlanResult {
	budgetPlan: MonthlyBudgetV2PlanItem;
	idempotentReplay: boolean;
}

export interface VoidMonthlyBudgetV2PlanParams {
	db: Database;
	userId: string;
	budgetPlanId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface VoidMonthlyBudgetV2PlanResult {
	budgetPlan: MonthlyBudgetV2PlanItem;
	idempotentReplay: boolean;
}

export interface GetMonthlyBudgetV2PlanParams {
	db: Database;
	userId: string;
	budgetPlanId?: string | undefined;
	periodMonth?: string | undefined;
}

export interface ListMonthlyBudgetV2PlansParams {
	db: Database;
	userId: string;
	periodMonthFrom?: string | undefined;
	periodMonthUntil?: string | undefined;
}

// ============================================================================
// Shared helpers
// ============================================================================

function requireUserId(userId: string): void {
	if (!userId || userId.trim() === "") {
		throw new BudgetError("BUDGET_INVALID_INPUT", "User ID is required");
	}
}

function requireIdempotencyKey(idempotencyKey: string): string {
	const trimmed = idempotencyKey?.trim();
	if (!trimmed) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Idempotency key is required",
		);
	}
	return trimmed;
}

function requireReasonCode(reasonCode: string): string {
	const trimmed = reasonCode?.trim();
	if (!trimmed) {
		throw new BudgetError("BUDGET_INVALID_INPUT", "Reason code is required");
	}
	return trimmed;
}

function revisionValues(args: {
	userId: string;
	budgetPlanId: string;
	canonicalRevisionId: string;
	revisionNo: number;
	previousBudgetRevisionId: string | null;
	operation: "CREATE" | "UPDATE" | "VOID";
	currency: string;
	inputs: BudgetV2InputAmounts;
	outputs: BudgetV2OutputAmounts;
	evidenceSnapshot: Record<string, unknown>;
}): typeof monthlyBudgetV2PlanRevisions.$inferInsert {
	return {
		userId: args.userId,
		budgetPlanId: args.budgetPlanId,
		canonicalRevisionId: args.canonicalRevisionId,
		revisionNo: args.revisionNo,
		previousBudgetRevisionId: args.previousBudgetRevisionId,
		operation: args.operation,
		policyVersion: PERSONAL_BUDGET_V2,
		currency: args.currency,
		realizedIncomeAmount: args.inputs.realizedIncome,
		currentObligationsAmount: args.inputs.currentObligations,
		basicLivingFundingAmount: args.inputs.basicLivingFunding,
		dateBoundNecessaryPurchaseFundingAmount:
			args.inputs.dateBoundNecessaryPurchaseFunding,
		coreEmergencyFundBalanceAmount: args.inputs.coreEmergencyFundBalance,
		mobilityBalanceAmount: args.inputs.mobilityBalance,
		emergencyCatchUpAmount: args.outputs.emergencyCatchUp,
		deficitAmount: args.outputs.deficit,
		trueSurplusAmount: args.outputs.trueSurplus,
		mobilityAllocationAmount: args.outputs.mobilityAllocation,
		longTermInvestmentAmount: args.outputs.longTermInvestment,
		discretionaryAllocationAmount: args.outputs.discretionaryAllocation,
		evidenceSnapshot: args.evidenceSnapshot,
	};
}

function outputsFromPolicy(
	result: ReturnType<typeof validateBudgetV2ResolvedSnapshot>["policyResult"],
): BudgetV2OutputAmounts {
	return {
		emergencyCatchUp: result.outputs.emergencyCatchUp.amount,
		deficit: result.outputs.deficit.amount,
		trueSurplus: result.outputs.trueSurplus.amount,
		mobilityAllocation: result.outputs.mobilityAllocation.amount,
		longTermInvestment: result.outputs.longTermInvestment.amount,
		discretionaryAllocation: result.outputs.discretionaryAllocation.amount,
	};
}

function outputsFromRevision(
	rev: typeof monthlyBudgetV2PlanRevisions.$inferSelect,
): BudgetV2OutputAmounts {
	return {
		emergencyCatchUp: rev.emergencyCatchUpAmount,
		deficit: rev.deficitAmount,
		trueSurplus: rev.trueSurplusAmount,
		mobilityAllocation: rev.mobilityAllocationAmount,
		longTermInvestment: rev.longTermInvestmentAmount,
		discretionaryAllocation: rev.discretionaryAllocationAmount,
	};
}

function inputsFromRevision(
	rev: typeof monthlyBudgetV2PlanRevisions.$inferSelect,
): BudgetV2InputAmounts {
	return {
		realizedIncome: rev.realizedIncomeAmount,
		currentObligations: rev.currentObligationsAmount,
		basicLivingFunding: rev.basicLivingFundingAmount,
		dateBoundNecessaryPurchaseFunding:
			rev.dateBoundNecessaryPurchaseFundingAmount,
		coreEmergencyFundBalance: rev.coreEmergencyFundBalanceAmount,
		mobilityBalance: rev.mobilityBalanceAmount,
	};
}

// ============================================================================
// 5A / 5B  CREATE
// ============================================================================

/**
 * Creates a PERSONAL_BUDGET_V2 monthly plan from a trusted resolved snapshot.
 * NON-POSTING: no journal entry, no ledger binding, no Midas transfer.
 * Historical idempotency is checked FIRST (before any fresh transaction).
 */
export async function createMonthlyBudgetV2Plan(
	params: CreateMonthlyBudgetV2PlanParams,
): Promise<CreateMonthlyBudgetV2PlanResult> {
	const { db, userId, provenance } = params;
	requireUserId(userId);
	const validPeriod = validateBudgetPeriodMonth(params.periodMonth);
	const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
	const validated = validateBudgetV2ResolvedSnapshot(params.resolvedSnapshot);

	// 1. HISTORICAL IDEMPOTENCY CHECK FIRST -----------------------------------
	const [existingCanon] = await db
		.select()
		.from(canonicalTransactions)
		.where(
			and(
				eq(canonicalTransactions.userId, userId),
				eq(canonicalTransactions.creationIdempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	if (existingCanon) {
		if (existingCanon.kind !== BUDGET_V2_CANONICAL_KIND) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${idempotencyKey}" already used for kind "${existingCanon.kind}"`,
			);
		}

		const [plan] = await db
			.select()
			.from(monthlyBudgetV2Plans)
			.where(
				and(
					eq(monthlyBudgetV2Plans.canonicalTransactionId, existingCanon.id),
					eq(monthlyBudgetV2Plans.userId, userId),
				),
			)
			.limit(1);

		if (!plan) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Corrupted state: V2 canonical transaction exists but plan anchor is missing",
			);
		}

		if (plan.periodMonth !== validPeriod) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${idempotencyKey}" was previously used for period "${plan.periodMonth}", cannot reuse for "${validPeriod}"`,
			);
		}

		const [rev1] = await db
			.select()
			.from(monthlyBudgetV2PlanRevisions)
			.where(
				and(
					eq(monthlyBudgetV2PlanRevisions.budgetPlanId, plan.id),
					eq(monthlyBudgetV2PlanRevisions.userId, userId),
					eq(monthlyBudgetV2PlanRevisions.revisionNo, 1),
				),
			)
			.limit(1);

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

		if (!rev1 || !storedCanonRev) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Corrupted state: V2 plan revision #1 or canonical revision #1 is missing",
			);
		}

		if (
			rev1.canonicalRevisionId !== storedCanonRev.id ||
			storedCanonRev.revisionNo !== 1 ||
			storedCanonRev.operation !== "CREATE"
		) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Historical V2 plan revision linkage is inconsistent with canonical revision",
			);
		}

		// Strict changed-parameter check: the supplied snapshot must reproduce
		// the exact stored creation payload. Any changed input / evidence /
		// period is an idempotency conflict, never a silent recompute.
		const candidatePayload = buildBudgetV2CanonicalPayload({
			periodMonth: validPeriod,
			currency: rev1.currency,
			policyResult: validated.policyResult,
			evidenceSnapshot: validated.evidenceSnapshot,
		});
		if (
			canonicalJsonOf(candidatePayload) !==
			canonicalJsonOf(storedCanonRev.payload as Record<string, unknown>)
		) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${idempotencyKey}" was previously used with a different resolved snapshot`,
			);
		}

		// Validate provenance fingerprint via the canonical service (changed
		// provenance -> TRANSACTION_IDEMPOTENCY_CONFLICT).
		return await db.transaction(async (tx) => {
			try {
				const canonRes = await createCanonicalTransactionInTransaction({
					tx,
					userId,
					kind: BUDGET_V2_CANONICAL_KIND,
					idempotencyKey,
					occurredAt: storedCanonRev.occurredAt,
					payload: storedCanonRev.payload as Record<string, unknown>,
					source: provenance,
				});
				if (!canonRes.idempotentReplay) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Expected canonical idempotent replay but got fresh V2 creation",
					);
				}
				if (
					plan.canonicalTransactionId !== canonRes.transactionId ||
					rev1.canonicalRevisionId !== canonRes.revisionId
				) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Historical V2 plan projection does not match canonical replay result",
					);
				}
				return {
					budgetPlan: formatV2Item(plan, rev1),
					idempotentReplay: true,
				};
			} catch (err: unknown) {
				if (err instanceof BudgetError) throw err;
				mapCanonicalError(err);
			}
		});
	}

	// 2. FRESH CREATE -------------------------------------------------------
	return await db.transaction(
		async (tx) => {
			const [user] = await tx
				.select({ currency: users.currency })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);
			if (!user) {
				throw new BudgetError("BUDGET_INVALID_INPUT", "User not found");
			}

			const [existingPlan] = await tx
				.select()
				.from(monthlyBudgetV2Plans)
				.where(
					and(
						eq(monthlyBudgetV2Plans.userId, userId),
						eq(monthlyBudgetV2Plans.periodMonth, validPeriod),
					),
				)
				.limit(1);
			if (existingPlan) {
				throw new BudgetError(
					"BUDGET_PERIOD_CONFLICT",
					`Monthly budget V2 plan already exists for period "${validPeriod}"`,
				);
			}

			const occurredAt = getIstanbulDateAtMidnightUtc(validPeriod);
			const payload = buildBudgetV2CanonicalPayload({
				periodMonth: validPeriod,
				currency: user.currency,
				policyResult: validated.policyResult,
				evidenceSnapshot: validated.evidenceSnapshot,
			});

			let canonRes: Awaited<
				ReturnType<typeof createCanonicalTransactionInTransaction>
			>;
			try {
				canonRes = await createCanonicalTransactionInTransaction({
					tx,
					userId,
					kind: BUDGET_V2_CANONICAL_KIND,
					idempotencyKey,
					occurredAt,
					payload,
					source: provenance,
				});
			} catch (err: unknown) {
				mapCanonicalError(err);
			}

			if (canonRes.idempotentReplay) {
				const [planReplay] = await tx
					.select()
					.from(monthlyBudgetV2Plans)
					.where(
						and(
							eq(
								monthlyBudgetV2Plans.canonicalTransactionId,
								canonRes.transactionId,
							),
							eq(monthlyBudgetV2Plans.userId, userId),
						),
					)
					.limit(1);
				const [revReplay] = planReplay
					? await tx
							.select()
							.from(monthlyBudgetV2PlanRevisions)
							.where(
								and(
									eq(monthlyBudgetV2PlanRevisions.budgetPlanId, planReplay.id),
									eq(monthlyBudgetV2PlanRevisions.userId, userId),
									eq(monthlyBudgetV2PlanRevisions.revisionNo, 1),
								),
							)
							.limit(1)
					: [];
				if (!planReplay || !revReplay) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Canonical V2 replay succeeded but plan/revision row missing",
					);
				}
				return {
					budgetPlan: formatV2Item(planReplay, revReplay),
					idempotentReplay: true,
				};
			}

			let createdPlan: typeof monthlyBudgetV2Plans.$inferSelect | undefined;
			try {
				const [inserted] = await tx
					.insert(monthlyBudgetV2Plans)
					.values({
						userId,
						periodMonth: validPeriod,
						canonicalTransactionId: canonRes.transactionId,
					})
					.returning();
				createdPlan = inserted;
			} catch (err: unknown) {
				if (isBudgetV2PeriodUniqueViolation(err)) {
					throw new BudgetError(
						"BUDGET_PERIOD_CONFLICT",
						`Monthly budget V2 plan already exists for period "${validPeriod}"`,
					);
				}
				throw err;
			}
			if (!createdPlan) {
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					"Failed to create V2 plan anchor",
				);
			}

			const [createdRev] = await tx
				.insert(monthlyBudgetV2PlanRevisions)
				.values(
					revisionValues({
						userId,
						budgetPlanId: createdPlan.id,
						canonicalRevisionId: canonRes.revisionId,
						revisionNo: 1,
						previousBudgetRevisionId: null,
						operation: "CREATE",
						currency: user.currency,
						inputs: validated.inputs,
						outputs: outputsFromPolicy(validated.policyResult),
						evidenceSnapshot: validated.evidenceSnapshot,
					}),
				)
				.returning();
			if (!createdRev) {
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					"Failed to insert V2 plan revision #1",
				);
			}

			return {
				budgetPlan: formatV2Item(createdPlan, createdRev),
				idempotentReplay: false,
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}

// ============================================================================
// 5C  REFRESH / UPDATE
// ============================================================================

export async function refreshMonthlyBudgetV2Plan(
	params: RefreshMonthlyBudgetV2PlanParams,
): Promise<RefreshMonthlyBudgetV2PlanResult> {
	const { db, userId, expectedRevisionNo, provenance, reasonNote } = params;
	requireUserId(userId);
	const planId = normalizeUuid(params.budgetPlanId, "budgetPlanId");
	const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
	const reasonCode = requireReasonCode(params.reasonCode);
	const validated = validateBudgetV2ResolvedSnapshot(params.resolvedSnapshot);

	return await db.transaction(
		async (tx) => {
			const [plan] = await tx
				.select()
				.from(monthlyBudgetV2Plans)
				.where(
					and(
						eq(monthlyBudgetV2Plans.id, planId),
						eq(monthlyBudgetV2Plans.userId, userId),
					),
				)
				.for("update")
				.limit(1);
			if (!plan) {
				throw new BudgetError(
					"BUDGET_PLAN_NOT_FOUND",
					`Monthly budget V2 plan "${planId}" not found`,
				);
			}

			// HISTORICAL IDEMPOTENCY CHECK FIRST (before VOID guard / OCC).
			const [existingCanonRev] = await tx
				.select()
				.from(transactionRevisions)
				.where(
					and(
						eq(transactionRevisions.transactionId, plan.canonicalTransactionId),
						eq(transactionRevisions.idempotencyKey, idempotencyKey),
						eq(transactionRevisions.operation, "UPDATE"),
					),
				)
				.limit(1);

			if (existingCanonRev) {
				const storedPayload = existingCanonRev.payload as Record<
					string,
					unknown
				>;
				const candidatePayload = buildBudgetV2CanonicalPayload({
					periodMonth: plan.periodMonth,
					currency: String(storedPayload.currency ?? ""),
					policyResult: validated.policyResult,
					evidenceSnapshot: validated.evidenceSnapshot,
				});
				if (
					canonicalJsonOf(candidatePayload) !== canonicalJsonOf(storedPayload)
				) {
					throw new BudgetError(
						"BUDGET_IDEMPOTENCY_CONFLICT",
						`Refresh idempotency key "${idempotencyKey}" was previously used with a different resolved snapshot`,
					);
				}

				let canonRes: Awaited<
					ReturnType<typeof reviseCanonicalTransactionInTransaction>
				>;
				try {
					canonRes = await reviseCanonicalTransactionInTransaction({
						tx,
						userId,
						transactionId: plan.canonicalTransactionId,
						expectedRevisionNo: existingCanonRev.revisionNo - 1,
						idempotencyKey,
						occurredAt: existingCanonRev.occurredAt,
						payload: storedPayload,
						reasonCode,
						reasonNote,
						source: provenance,
					});
				} catch (err: unknown) {
					mapCanonicalError(err);
				}
				if (!canonRes.idempotentReplay) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Expected canonical idempotent replay but got fresh V2 revision",
					);
				}

				const [storedPlanRev] = await tx
					.select()
					.from(monthlyBudgetV2PlanRevisions)
					.where(
						and(
							eq(
								monthlyBudgetV2PlanRevisions.canonicalRevisionId,
								canonRes.revisionId,
							),
							eq(monthlyBudgetV2PlanRevisions.userId, userId),
						),
					)
					.limit(1);
				if (
					!storedPlanRev ||
					plan.canonicalTransactionId !== canonRes.transactionId ||
					storedPlanRev.revisionNo !== canonRes.revisionNo ||
					storedPlanRev.operation !== canonRes.operation
				) {
					throw new BudgetError(
						"BUDGET_INVALID_STATE",
						"Historical V2 plan projection does not match canonical replay result",
					);
				}
				return {
					budgetPlan: formatV2Item(plan, storedPlanRev),
					idempotentReplay: true,
				};
			}

			// FRESH UPDATE
			const [latestRev] = await tx
				.select()
				.from(monthlyBudgetV2PlanRevisions)
				.where(
					and(
						eq(monthlyBudgetV2PlanRevisions.budgetPlanId, plan.id),
						eq(monthlyBudgetV2PlanRevisions.userId, userId),
					),
				)
				.orderBy(desc(monthlyBudgetV2PlanRevisions.revisionNo))
				.limit(1);
			if (!latestRev) {
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					"Monthly budget V2 plan has no revisions",
				);
			}
			if (latestRev.operation === "VOID") {
				throw new BudgetError(
					"BUDGET_ALREADY_VOIDED",
					`Cannot refresh VOIDED monthly budget V2 plan "${plan.id}"`,
				);
			}
			if (latestRev.revisionNo !== expectedRevisionNo) {
				throw new BudgetError(
					"BUDGET_REVISION_CONFLICT",
					`Expected revision ${expectedRevisionNo}, but latest revision is ${latestRev.revisionNo}`,
				);
			}

			const occurredAt = getIstanbulDateAtMidnightUtc(plan.periodMonth);
			const payload = buildBudgetV2CanonicalPayload({
				periodMonth: plan.periodMonth,
				currency: latestRev.currency,
				policyResult: validated.policyResult,
				evidenceSnapshot: validated.evidenceSnapshot,
			});

			let canonRes: Awaited<
				ReturnType<typeof reviseCanonicalTransactionInTransaction>
			>;
			try {
				canonRes = await reviseCanonicalTransactionInTransaction({
					tx,
					userId,
					transactionId: plan.canonicalTransactionId,
					expectedRevisionNo,
					idempotencyKey,
					occurredAt,
					payload,
					reasonCode,
					reasonNote,
					source: provenance,
				});
			} catch (err: unknown) {
				mapCanonicalError(err);
			}

			if (canonRes.idempotentReplay) {
				const [storedPlanRev] = await tx
					.select()
					.from(monthlyBudgetV2PlanRevisions)
					.where(
						and(
							eq(
								monthlyBudgetV2PlanRevisions.canonicalRevisionId,
								canonRes.revisionId,
							),
							eq(monthlyBudgetV2PlanRevisions.userId, userId),
						),
					)
					.limit(1);
				if (storedPlanRev) {
					return {
						budgetPlan: formatV2Item(plan, storedPlanRev),
						idempotentReplay: true,
					};
				}
			}

			const [newRev] = await tx
				.insert(monthlyBudgetV2PlanRevisions)
				.values(
					revisionValues({
						userId,
						budgetPlanId: plan.id,
						canonicalRevisionId: canonRes.revisionId,
						revisionNo: expectedRevisionNo + 1,
						previousBudgetRevisionId: latestRev.id,
						operation: "UPDATE",
						currency: latestRev.currency,
						inputs: validated.inputs,
						outputs: outputsFromPolicy(validated.policyResult),
						evidenceSnapshot: validated.evidenceSnapshot,
					}),
				)
				.returning();
			if (!newRev) {
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					"Failed to insert updated V2 plan revision",
				);
			}

			return {
				budgetPlan: formatV2Item(plan, newRev),
				idempotentReplay: false,
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}

// ============================================================================
// 5D  VOID
// ============================================================================

export async function voidMonthlyBudgetV2Plan(
	params: VoidMonthlyBudgetV2PlanParams,
): Promise<VoidMonthlyBudgetV2PlanResult> {
	const { db, userId, expectedRevisionNo, provenance, reasonNote } = params;
	requireUserId(userId);
	const planId = normalizeUuid(params.budgetPlanId, "budgetPlanId");
	const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
	const reasonCode = requireReasonCode(params.reasonCode);

	return await db.transaction(async (tx) => {
		const [plan] = await tx
			.select()
			.from(monthlyBudgetV2Plans)
			.where(
				and(
					eq(monthlyBudgetV2Plans.id, planId),
					eq(monthlyBudgetV2Plans.userId, userId),
				),
			)
			.for("update")
			.limit(1);
		if (!plan) {
			throw new BudgetError(
				"BUDGET_PLAN_NOT_FOUND",
				`Monthly budget V2 plan "${planId}" not found`,
			);
		}

		const [latestRev] = await tx
			.select()
			.from(monthlyBudgetV2PlanRevisions)
			.where(
				and(
					eq(monthlyBudgetV2PlanRevisions.budgetPlanId, plan.id),
					eq(monthlyBudgetV2PlanRevisions.userId, userId),
				),
			)
			.orderBy(desc(monthlyBudgetV2PlanRevisions.revisionNo))
			.limit(1);
		if (!latestRev) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Monthly budget V2 plan has no revisions",
			);
		}

		// The canonical void lifecycle owns idempotent replay, already-voided,
		// revision-conflict and changed reason/provenance detection.
		let canonRes: Awaited<
			ReturnType<typeof voidCanonicalTransactionInTransaction>
		>;
		try {
			canonRes = await voidCanonicalTransactionInTransaction({
				tx,
				userId,
				transactionId: plan.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey,
				reasonCode,
				reasonNote,
				source: provenance,
			});
		} catch (err: unknown) {
			mapCanonicalError(err);
		}

		if (canonRes.idempotentReplay) {
			const [storedPlanRev] = await tx
				.select()
				.from(monthlyBudgetV2PlanRevisions)
				.where(
					and(
						eq(
							monthlyBudgetV2PlanRevisions.canonicalRevisionId,
							canonRes.revisionId,
						),
						eq(monthlyBudgetV2PlanRevisions.userId, userId),
					),
				)
				.limit(1);
			if (storedPlanRev) {
				return {
					budgetPlan: formatV2Item(plan, storedPlanRev),
					idempotentReplay: true,
				};
			}
		}

		if (latestRev.operation === "VOID") {
			throw new BudgetError(
				"BUDGET_ALREADY_VOIDED",
				`Monthly budget V2 plan "${plan.id}" is already VOIDED`,
			);
		}

		// VOID projection copies the predecessor's six inputs, six outputs, and
		// evidence EXACTLY -- no recomputation, no live source read, no money move.
		const [newRev] = await tx
			.insert(monthlyBudgetV2PlanRevisions)
			.values(
				revisionValues({
					userId,
					budgetPlanId: plan.id,
					canonicalRevisionId: canonRes.revisionId,
					revisionNo: expectedRevisionNo + 1,
					previousBudgetRevisionId: latestRev.id,
					operation: "VOID",
					currency: latestRev.currency,
					inputs: inputsFromRevision(latestRev),
					outputs: outputsFromRevision(latestRev),
					evidenceSnapshot: latestRev.evidenceSnapshot as Record<
						string,
						unknown
					>,
				}),
			)
			.returning();
		if (!newRev) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Failed to insert void V2 plan revision",
			);
		}

		return {
			budgetPlan: formatV2Item(plan, newRev),
			idempotentReplay: false,
		};
	});
}

// ============================================================================
// 5E  GET / LIST
// ============================================================================

export async function getMonthlyBudgetV2Plan(
	params: GetMonthlyBudgetV2PlanParams,
): Promise<MonthlyBudgetV2PlanItem> {
	const { db, userId, budgetPlanId, periodMonth } = params;
	requireUserId(userId);
	if (!budgetPlanId && !periodMonth) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Either budgetPlanId or periodMonth is required",
		);
	}

	const conditions = [eq(monthlyBudgetV2Plans.userId, userId)];
	if (budgetPlanId) {
		conditions.push(
			eq(monthlyBudgetV2Plans.id, normalizeUuid(budgetPlanId, "budgetPlanId")),
		);
	}
	if (periodMonth) {
		conditions.push(
			eq(
				monthlyBudgetV2Plans.periodMonth,
				validateBudgetPeriodMonth(periodMonth),
			),
		);
	}

	const [plan] = await db
		.select()
		.from(monthlyBudgetV2Plans)
		.where(and(...conditions))
		.limit(1);
	if (!plan) {
		throw new BudgetError(
			"BUDGET_PLAN_NOT_FOUND",
			budgetPlanId
				? `Monthly budget V2 plan "${budgetPlanId}" not found`
				: `Monthly budget V2 plan for period "${periodMonth}" not found`,
		);
	}

	const [latestRev] = await db
		.select()
		.from(monthlyBudgetV2PlanRevisions)
		.where(
			and(
				eq(monthlyBudgetV2PlanRevisions.budgetPlanId, plan.id),
				eq(monthlyBudgetV2PlanRevisions.userId, userId),
			),
		)
		.orderBy(desc(monthlyBudgetV2PlanRevisions.revisionNo))
		.limit(1);
	if (!latestRev) {
		throw new BudgetError(
			"BUDGET_INVALID_STATE",
			"Monthly budget V2 plan has no revisions",
		);
	}

	return formatV2Item(plan, latestRev);
}

/**
 * Lists V2 plans for a user, latest revision each, ordered periodMonth DESC,
 * id ASC (consistent with the V1 list convention).
 */
export async function listMonthlyBudgetV2Plans(
	params: ListMonthlyBudgetV2PlansParams,
): Promise<MonthlyBudgetV2PlanItem[]> {
	const { db, userId, periodMonthFrom, periodMonthUntil } = params;
	requireUserId(userId);

	const conditions = [eq(monthlyBudgetV2Plans.userId, userId)];
	let validFrom: string | undefined;
	let validUntil: string | undefined;
	if (periodMonthFrom && periodMonthFrom.trim() !== "") {
		validFrom = validateBudgetPeriodMonth(periodMonthFrom);
		conditions.push(gte(monthlyBudgetV2Plans.periodMonth, validFrom));
	}
	if (periodMonthUntil && periodMonthUntil.trim() !== "") {
		validUntil = validateBudgetPeriodMonth(periodMonthUntil);
		conditions.push(lte(monthlyBudgetV2Plans.periodMonth, validUntil));
	}
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
		.from(monthlyBudgetV2Plans)
		.where(and(...conditions))
		.orderBy(
			desc(monthlyBudgetV2Plans.periodMonth),
			asc(monthlyBudgetV2Plans.id),
		);
	if (plans.length === 0) return [];

	const planIds = plans.map((p) => p.id);
	const allRevs = await db
		.select()
		.from(monthlyBudgetV2PlanRevisions)
		.where(
			and(
				eq(monthlyBudgetV2PlanRevisions.userId, userId),
				inArray(monthlyBudgetV2PlanRevisions.budgetPlanId, planIds),
			),
		)
		.orderBy(desc(monthlyBudgetV2PlanRevisions.revisionNo));

	const latestByPlan = new Map<
		string,
		typeof monthlyBudgetV2PlanRevisions.$inferSelect
	>();
	for (const rev of allRevs) {
		if (!latestByPlan.has(rev.budgetPlanId)) {
			latestByPlan.set(rev.budgetPlanId, rev);
		}
	}

	const result: MonthlyBudgetV2PlanItem[] = [];
	for (const plan of plans) {
		const latestRev = latestByPlan.get(plan.id);
		if (latestRev) result.push(formatV2Item(plan, latestRev));
	}
	return result;
}

import { and, desc, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	budgetV2CheckpointSnapshots,
	budgetV2RecommendationFeedbackRevisions,
	budgetV2RecommendationInstances,
} from "../db/schema";
import { parseAggregateMoneyString } from "../ledger/money";
import { buildBudgetV2RecommendationReviewSet } from "./behavior-recommendations-review-v2";
import type { BudgetV2Recommendation } from "./behavior-recommendations-v2";
import {
	canonicalJsonStringify,
	verifyStoredCheckpointSnapshot,
} from "./checkpoint-canonical-v2";
import type { SurplusUseLaneName } from "./checkpoint-report-v2";
import { BudgetError } from "./errors";
import {
	calculateFeedbackRevisionFingerprint,
	type StoredBudgetV2RecommendationFeedbackRevisionRow,
	type StoredBudgetV2RecommendationInstanceRow,
	verifyStoredBudgetV2RecommendationFeedbackRevision,
	verifyStoredBudgetV2RecommendationInstance,
} from "./recommendation-feedback-canonical-v2";

// ============================================================================
// Types
// ============================================================================

export type BudgetV2RecommendationDecision = "ACCEPT" | "MODIFY" | "IGNORE";

export interface BudgetV2NoteOnlyModification {
	type: "NOTE_ONLY";
	note: string;
}

export interface BudgetV2SweepReviewModification {
	type: "SWEEP_REVIEW";
	suggestedReviewAmount: string;
	destination: "INTERNATIONAL_MOBILITY" | "LONG_TERM_INVESTMENT" | null;
	note?: string;
}

export type BudgetV2RecommendationModification =
	| BudgetV2NoteOnlyModification
	| BudgetV2SweepReviewModification;

export interface CreateBudgetV2RecommendationFeedbackInput {
	userId: string;
	throughPaymentEventId: string;
	recommendationId: string;
	expectedRecommendationFingerprint: string;
	decision: BudgetV2RecommendationDecision;
	modification?: BudgetV2RecommendationModification | null;
	idempotencyKey: string;
	occurredAt: Date;
}

export interface UpdateBudgetV2RecommendationFeedbackInput {
	userId: string;
	recommendationId: string;
	expectedRevisionNo: number;
	decision: BudgetV2RecommendationDecision;
	modification?: BudgetV2RecommendationModification | null;
	idempotencyKey: string;
	occurredAt: Date;
}

export interface BudgetV2RecommendationFeedbackRevisionResult {
	id: string;
	userId: string;
	recommendationInstanceId: string;
	revisionNo: number;
	previousRevisionId: string | null;
	operation: "CREATE" | "UPDATE";
	decision: BudgetV2RecommendationDecision;
	modification: BudgetV2RecommendationModification | null;
	sourceKind: "USER_APPROVED";
	idempotencyKey: string;
	revisionFingerprint: string;
	occurredAt: Date;
	createdAt: Date;
}

export interface BudgetV2RecommendationFeedbackResult {
	instance: StoredBudgetV2RecommendationInstanceRow;
	revision: BudgetV2RecommendationFeedbackRevisionResult;
}

export interface BudgetV2RecommendationFeedbackAsOfResult {
	recommendation: StoredBudgetV2RecommendationInstanceRow | null;
	feedback: BudgetV2RecommendationFeedbackRevisionResult | null;
	status: "UNRESPONDED" | "ACCEPT" | "MODIFY" | "IGNORE";
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatRevisionResult(
	rev: StoredBudgetV2RecommendationFeedbackRevisionRow,
): BudgetV2RecommendationFeedbackRevisionResult {
	return {
		id: rev.id,
		userId: rev.userId,
		recommendationInstanceId: rev.recommendationInstanceId,
		revisionNo: rev.revisionNo,
		previousRevisionId: rev.previousRevisionId,
		operation: rev.operation as "CREATE" | "UPDATE",
		decision: rev.decision as BudgetV2RecommendationDecision,
		modification:
			rev.modificationJson as BudgetV2RecommendationModification | null,
		sourceKind: rev.sourceKind as "USER_APPROVED",
		idempotencyKey: rev.idempotencyKey,
		revisionFingerprint: rev.revisionFingerprint,
		occurredAt:
			rev.occurredAt instanceof Date
				? rev.occurredAt
				: new Date(rev.occurredAt),
		createdAt:
			rev.createdAt instanceof Date ? rev.createdAt : new Date(rev.createdAt),
	};
}

function validateFiniteDate(d: unknown, fieldName: string): Date {
	if (
		!(d instanceof Date) ||
		Number.isNaN(d.getTime()) ||
		!Number.isFinite(d.getTime())
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`${fieldName} must be a valid finite Date`,
		);
	}
	return d;
}

function isUniqueViolationOnConstraint(
	err: unknown,
	constraintName: string,
): boolean {
	let current: unknown = err;
	let depth = 0;
	while (current && depth < 10) {
		const obj = current as {
			code?: string;
			constraint?: string;
			detail?: string;
			message?: string;
			cause?: unknown;
		};
		if (obj.code === "23505") {
			if (obj.constraint === constraintName) {
				return true;
			}
			const detail = (obj.detail || obj.message || "").toLowerCase();
			if (detail.includes(constraintName.toLowerCase())) {
				return true;
			}
		}
		current = obj.cause;
		depth++;
	}
	return false;
}

function centsOrNull(v: string | null | undefined): bigint | null {
	if (typeof v !== "string") return null;
	try {
		return parseAggregateMoneyString(v).cents;
	} catch {
		return null;
	}
}

/**
 * Validates a decision and its modification against the frozen recommendation.
 * Enforces CLOSED modification schemas: NOTE_ONLY (for any kind) or
 * SWEEP_REVIEW (only for UNUSED_DISCRETIONARY_SWEEP_REVIEW).
 */
export function validateAndNormalizeModification(
	decision: BudgetV2RecommendationDecision,
	modification: BudgetV2RecommendationModification | null | undefined,
	frozenRec: BudgetV2Recommendation,
): BudgetV2RecommendationModification | null {
	if (decision === "ACCEPT" || decision === "IGNORE") {
		if (modification !== null && modification !== undefined) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`modification must be null for decision ${decision}`,
			);
		}
		return null;
	}

	// decision === "MODIFY"
	if (!modification || typeof modification !== "object") {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"modification payload is required for decision MODIFY",
		);
	}

	const modObj = modification as unknown as Record<string, unknown>;
	const type = modObj.type;

	if (type === "NOTE_ONLY") {
		const allowedKeys = new Set(["type", "note"]);
		for (const key of Object.keys(modObj)) {
			if (!allowedKeys.has(key)) {
				throw new BudgetError(
					"BUDGET_INVALID_INPUT",
					`unauthorized key '${key}' in NOTE_ONLY modification`,
				);
			}
		}
		if (typeof modObj.note !== "string") {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				"NOTE_ONLY modification requires a string 'note'",
			);
		}
		const trimmedNote = modObj.note.trim();
		if (trimmedNote.length < 1 || trimmedNote.length > 500) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				"NOTE_ONLY note must have trimmed length between 1 and 500 characters",
			);
		}
		return {
			type: "NOTE_ONLY",
			note: trimmedNote,
		};
	}

	if (type === "SWEEP_REVIEW") {
		if (frozenRec.kind !== "UNUSED_DISCRETIONARY_SWEEP_REVIEW") {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`SWEEP_REVIEW modification is only permitted for UNUSED_DISCRETIONARY_SWEEP_REVIEW, not ${frozenRec.kind}`,
			);
		}
		const allowedKeys = new Set([
			"type",
			"suggestedReviewAmount",
			"destination",
			"note",
		]);
		for (const key of Object.keys(modObj)) {
			if (!allowedKeys.has(key)) {
				throw new BudgetError(
					"BUDGET_INVALID_INPUT",
					`unauthorized key '${key}' in SWEEP_REVIEW modification`,
				);
			}
		}

		if (typeof modObj.suggestedReviewAmount !== "string") {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				"SWEEP_REVIEW requires suggestedReviewAmount string",
			);
		}

		const modCents = centsOrNull(modObj.suggestedReviewAmount);
		if (modCents === null || modCents <= 0n) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				"SWEEP_REVIEW suggestedReviewAmount must be a positive decimal money string",
			);
		}

		const proposedAction = frozenRec.proposedAction as {
			action: string;
			suggestedReviewAmount?: string;
			allowedReviewDestinations?: readonly SurplusUseLaneName[];
		};

		const origCents = centsOrNull(proposedAction.suggestedReviewAmount);
		if (origCents === null || modCents > origCents) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`SWEEP_REVIEW modified amount (${modObj.suggestedReviewAmount}) cannot exceed original suggestion (${proposedAction.suggestedReviewAmount})`,
			);
		}

		const destination = modObj.destination;
		const allowedDestinations = proposedAction.allowedReviewDestinations ?? [];
		if (destination !== null) {
			if (
				typeof destination !== "string" ||
				!allowedDestinations.includes(destination as SurplusUseLaneName)
			) {
				throw new BudgetError(
					"BUDGET_INVALID_INPUT",
					`SWEEP_REVIEW destination '${String(destination)}' must be null or one of: ${allowedDestinations.join(", ")}`,
				);
			}
		}

		let note: string | undefined;
		if (modObj.note !== undefined && modObj.note !== null) {
			if (typeof modObj.note !== "string") {
				throw new BudgetError(
					"BUDGET_INVALID_INPUT",
					"SWEEP_REVIEW note must be a string",
				);
			}
			const trimmed = modObj.note.trim();
			if (trimmed.length > 500) {
				throw new BudgetError(
					"BUDGET_INVALID_INPUT",
					"SWEEP_REVIEW note must be <= 500 characters",
				);
			}
			if (trimmed.length > 0) {
				note = trimmed;
			}
		}

		return {
			type: "SWEEP_REVIEW",
			suggestedReviewAmount: modObj.suggestedReviewAmount,
			destination: destination as
				| "INTERNATIONAL_MOBILITY"
				| "LONG_TERM_INVESTMENT"
				| null,
			...(note !== undefined ? { note } : {}),
		};
	}

	throw new BudgetError(
		"BUDGET_INVALID_INPUT",
		`unsupported modification type '${String(type)}'`,
	);
}

// ============================================================================
// Service: createBudgetV2RecommendationFeedback
// ============================================================================

export async function createBudgetV2RecommendationFeedback(
	db: Database,
	input: CreateBudgetV2RecommendationFeedbackInput,
): Promise<BudgetV2RecommendationFeedbackResult> {
	const userId = input.userId?.trim();
	const throughPaymentEventId = input.throughPaymentEventId?.trim();
	const recommendationId = input.recommendationId?.trim();
	const expectedRecommendationFingerprint =
		input.expectedRecommendationFingerprint?.trim();
	const idempotencyKey = input.idempotencyKey?.trim();
	const decision = input.decision;
	const occurredAt = validateFiniteDate(input.occurredAt, "occurredAt");

	if (
		!userId ||
		!throughPaymentEventId ||
		!recommendationId ||
		!expectedRecommendationFingerprint ||
		!idempotencyKey
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"missing required input fields for createBudgetV2RecommendationFeedback",
		);
	}

	if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"idempotencyKey must be 1..128 characters",
		);
	}

	if (!["ACCEPT", "MODIFY", "IGNORE"].includes(decision)) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`invalid decision '${decision}'`,
		);
	}

	if (!/^[0-9a-f]{64}$/.test(expectedRecommendationFingerprint)) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"expectedRecommendationFingerprint must be a 64-character lowercase hex string",
		);
	}

	// 1. Fast historical idempotency lookup BEFORE recommendation regeneration
	const existingRevs = await db
		.select()
		.from(budgetV2RecommendationFeedbackRevisions)
		.where(
			and(
				eq(budgetV2RecommendationFeedbackRevisions.userId, userId),
				eq(
					budgetV2RecommendationFeedbackRevisions.idempotencyKey,
					idempotencyKey,
				),
			),
		)
		.limit(1);

	const [existingRev] = existingRevs;
	if (existingRev) {
		const instRows = await db
			.select()
			.from(budgetV2RecommendationInstances)
			.where(
				eq(
					budgetV2RecommendationInstances.id,
					existingRev.recommendationInstanceId,
				),
			)
			.limit(1);

		const [inst] = instRows;
		if (!inst) {
			throw new BudgetError(
				"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
				"stored feedback revision references missing recommendation instance",
			);
		}

		await verifyStoredBudgetV2RecommendationInstance(inst);
		await verifyStoredBudgetV2RecommendationFeedbackRevision(existingRev);

		// Normalize retry input modification AGAINST THE FROZEN recommendation instance
		const frozenRec = inst.recommendationJson as BudgetV2Recommendation;
		const normalizedRetryMod = validateAndNormalizeModification(
			decision,
			input.modification,
			frozenRec,
		);

		// Full CREATE command identity verification
		const sameRec = inst.recommendationId === recommendationId;
		const samePaymentEvent = inst.paymentEventId === throughPaymentEventId;
		const sameFingerprint =
			expectedRecommendationFingerprint === inst.recommendationFingerprint;
		const sameDecision = existingRev.decision === decision;
		const sameOp = existingRev.operation === "CREATE";
		const sameMod =
			canonicalJsonStringify(existingRev.modificationJson ?? null) ===
			canonicalJsonStringify(normalizedRetryMod ?? null);
		const sameOccurredAt =
			new Date(existingRev.occurredAt).getTime() === occurredAt.getTime();

		if (
			sameRec &&
			samePaymentEvent &&
			sameFingerprint &&
			sameDecision &&
			sameOp &&
			sameMod &&
			sameOccurredAt
		) {
			return {
				instance: inst,
				revision: formatRevisionResult(existingRev),
			};
		}

		throw new BudgetError(
			"BUDGET_IDEMPOTENCY_CONFLICT",
			`idempotency key '${idempotencyKey}' already used with different payload`,
		);
	}

	// 2. Transaction execution
	return await db.transaction(async (tx) => {
		// Lock target checkpoint snapshot
		const snapshots = await tx
			.select()
			.from(budgetV2CheckpointSnapshots)
			.where(
				and(
					eq(budgetV2CheckpointSnapshots.userId, userId),
					eq(budgetV2CheckpointSnapshots.paymentEventId, throughPaymentEventId),
				),
			)
			.for("update")
			.limit(1);

		const [snapshot] = snapshots;
		if (!snapshot) {
			throw new BudgetError(
				"BUDGET_BEHAVIOR_PROFILE_FAIL_CLOSED",
				"checkpoint snapshot not found for target payment event",
			);
		}

		await verifyStoredCheckpointSnapshot(snapshot);

		// Second idempotency lookup inside tx
		const txExistingRevs = await tx
			.select()
			.from(budgetV2RecommendationFeedbackRevisions)
			.where(
				and(
					eq(budgetV2RecommendationFeedbackRevisions.userId, userId),
					eq(
						budgetV2RecommendationFeedbackRevisions.idempotencyKey,
						idempotencyKey,
					),
				),
			)
			.limit(1);

		const [txExistingRev] = txExistingRevs;
		if (txExistingRev) {
			const instRows = await tx
				.select()
				.from(budgetV2RecommendationInstances)
				.where(
					eq(
						budgetV2RecommendationInstances.id,
						txExistingRev.recommendationInstanceId,
					),
				)
				.limit(1);
			const [inst] = instRows;
			if (inst) {
				await verifyStoredBudgetV2RecommendationInstance(inst);
				await verifyStoredBudgetV2RecommendationFeedbackRevision(txExistingRev);
				const frozenRec = inst.recommendationJson as BudgetV2Recommendation;
				const normalizedRetryMod = validateAndNormalizeModification(
					decision,
					input.modification,
					frozenRec,
				);

				const sameRec = inst.recommendationId === recommendationId;
				const samePaymentEvent = inst.paymentEventId === throughPaymentEventId;
				const sameFingerprint =
					expectedRecommendationFingerprint === inst.recommendationFingerprint;
				const sameDecision = txExistingRev.decision === decision;
				const sameOp = txExistingRev.operation === "CREATE";
				const sameMod =
					canonicalJsonStringify(txExistingRev.modificationJson ?? null) ===
					canonicalJsonStringify(normalizedRetryMod ?? null);
				const sameOccurredAt =
					new Date(txExistingRev.occurredAt).getTime() === occurredAt.getTime();

				if (
					sameRec &&
					samePaymentEvent &&
					sameFingerprint &&
					sameDecision &&
					sameOp &&
					sameMod &&
					sameOccurredAt
				) {
					return {
						instance: inst,
						revision: formatRevisionResult(txExistingRev),
					};
				}
			}
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`idempotency key '${idempotencyKey}' already used with different payload`,
			);
		}

		// Check whether recommendation instance already exists
		const existingInsts = await tx
			.select()
			.from(budgetV2RecommendationInstances)
			.where(
				and(
					eq(budgetV2RecommendationInstances.userId, userId),
					eq(
						budgetV2RecommendationInstances.recommendationId,
						recommendationId,
					),
				),
			)
			.for("update")
			.limit(1);

		let instance: StoredBudgetV2RecommendationInstanceRow;
		let frozenRec: BudgetV2Recommendation;

		const [existingInst] = existingInsts;
		if (existingInst) {
			instance = existingInst;
			await verifyStoredBudgetV2RecommendationInstance(instance);

			// Check if a feedback revision already exists for this instance
			const existingRevsForInst = await tx
				.select()
				.from(budgetV2RecommendationFeedbackRevisions)
				.where(
					eq(
						budgetV2RecommendationFeedbackRevisions.recommendationInstanceId,
						instance.id,
					),
				)
				.limit(1);

			if (existingRevsForInst.length > 0) {
				const revForInst = existingRevsForInst[0];
				if (revForInst && revForInst.idempotencyKey === idempotencyKey) {
					await verifyStoredBudgetV2RecommendationFeedbackRevision(revForInst);
					const fRec = instance.recommendationJson as BudgetV2Recommendation;
					const normalizedRetryMod = validateAndNormalizeModification(
						decision,
						input.modification,
						fRec,
					);
					const sameRec = instance.recommendationId === recommendationId;
					const samePaymentEvent =
						instance.paymentEventId === throughPaymentEventId;
					const sameFingerprint =
						expectedRecommendationFingerprint ===
						instance.recommendationFingerprint;
					const sameDecision = revForInst.decision === decision;
					const sameOp = revForInst.operation === "CREATE";
					const sameMod =
						canonicalJsonStringify(revForInst.modificationJson ?? null) ===
						canonicalJsonStringify(normalizedRetryMod ?? null);
					const sameOccurredAt =
						new Date(revForInst.occurredAt).getTime() === occurredAt.getTime();

					if (
						sameRec &&
						samePaymentEvent &&
						sameFingerprint &&
						sameDecision &&
						sameOp &&
						sameMod &&
						sameOccurredAt
					) {
						return {
							instance,
							revision: formatRevisionResult(revForInst),
						};
					}
					throw new BudgetError(
						"BUDGET_IDEMPOTENCY_CONFLICT",
						`idempotency key '${idempotencyKey}' already used with different payload`,
					);
				}

				throw new BudgetError(
					"BUDGET_REVISION_CONFLICT",
					`feedback revision already exists for recommendation instance ${recommendationId}`,
				);
			}

			if (
				instance.recommendationFingerprint !== expectedRecommendationFingerprint
			) {
				throw new BudgetError(
					"BUDGET_RECOMMENDATION_STALE",
					"expected recommendation fingerprint does not match stored recommendation instance",
				);
			}

			frozenRec = instance.recommendationJson as BudgetV2Recommendation;
		} else {
			// Build reviewable recommendation set
			const reviewSet = await buildBudgetV2RecommendationReviewSet({
				db: tx as unknown as Database,
				userId,
				throughPaymentEventId,
			});

			const activeRec = reviewSet.recommendations.find(
				(r) => r.recommendationId === recommendationId,
			);

			if (!activeRec) {
				const isSuppressed = reviewSet.suppressed.some(
					(s) =>
						`budget-v2-rec:v1:${throughPaymentEventId}:${s.kind}:${s.scope}` ===
						recommendationId,
				);
				if (isSuppressed) {
					throw new BudgetError(
						"BUDGET_RECOMMENDATION_NOT_ACTIVE",
						"recommendation is suppressed and cannot be responded to",
					);
				}
				throw new BudgetError(
					"BUDGET_RECOMMENDATION_NOT_ACTIVE",
					"recommendation is not active in the current review set",
				);
			}

			if (
				activeRec.recommendationFingerprint !==
				expectedRecommendationFingerprint
			) {
				throw new BudgetError(
					"BUDGET_RECOMMENDATION_STALE",
					`expected fingerprint ${expectedRecommendationFingerprint} does not match active recommendation fingerprint ${activeRec.recommendationFingerprint}`,
				);
			}

			if (occurredAt.getTime() < new Date(snapshot.checkpointAt).getTime()) {
				throw new BudgetError(
					"BUDGET_INVALID_INPUT",
					`feedback occurredAt (${occurredAt.toISOString()}) cannot be before checkpointAt (${new Date(snapshot.checkpointAt).toISOString()})`,
				);
			}

			frozenRec = activeRec;

			// Insert immutable recommendation instance
			try {
				const inserted = await tx
					.insert(budgetV2RecommendationInstances)
					.values({
						userId,
						checkpointSnapshotId: snapshot.id,
						paymentEventId: throughPaymentEventId,
						recommendationId: activeRec.recommendationId,
						recommendationKind: activeRec.kind,
						recommendationScope: activeRec.scope,
						recommendationEngineVersion: reviewSet.engineVersion,
						behaviorEngineVersion:
							reviewSet.generatedFrom.behaviorEngineVersion,
						observationContractVersion:
							reviewSet.generatedFrom.observationContractVersion,
						priority: activeRec.priority,
						recommendationJson: activeRec,
						recommendationFingerprint: activeRec.recommendationFingerprint,
						capturedAt: occurredAt,
					})
					.returning();

				const [inst] = inserted;
				if (!inst) {
					throw new BudgetError(
						"BUDGET_REVISION_CONFLICT",
						"failed to insert recommendation instance",
					);
				}
				instance = inst;
			} catch (err: unknown) {
				if (
					isUniqueViolationOnConstraint(err, "bv2recinst_user_rec_id_idx") ||
					isUniqueViolationOnConstraint(err, "bv2recinst_user_semantic_idx")
				) {
					// Instance was concurrently created; re-fetch and verify
					const refetchedInsts = await tx
						.select()
						.from(budgetV2RecommendationInstances)
						.where(
							and(
								eq(budgetV2RecommendationInstances.userId, userId),
								eq(
									budgetV2RecommendationInstances.recommendationId,
									activeRec.recommendationId,
								),
							),
						)
						.limit(1);
					const [refetchedInst] = refetchedInsts;
					if (refetchedInst) {
						await verifyStoredBudgetV2RecommendationInstance(refetchedInst);
						instance = refetchedInst;
					} else {
						throw new BudgetError(
							"BUDGET_REVISION_CONFLICT",
							"concurrent creation conflict on recommendation instance",
						);
					}
				} else {
					throw err;
				}
			}
		}

		// Validate decision and modification against the frozen recommendation
		const normalizedMod = validateAndNormalizeModification(
			decision,
			input.modification,
			frozenRec,
		);

		// Calculate revision fingerprint
		const revisionFingerprint = await calculateFeedbackRevisionFingerprint({
			userId,
			recommendationInstanceId: instance.id,
			operation: "CREATE",
			revisionNo: 1,
			previousRevisionId: null,
			decision,
			modificationJson: normalizedMod,
			sourceKind: "USER_APPROVED",
			occurredAt,
		});

		try {
			const insertedRevs = await tx
				.insert(budgetV2RecommendationFeedbackRevisions)
				.values({
					userId,
					recommendationInstanceId: instance.id,
					revisionNo: 1,
					previousRevisionId: null,
					operation: "CREATE",
					decision,
					modificationJson: normalizedMod,
					sourceKind: "USER_APPROVED",
					idempotencyKey,
					revisionFingerprint,
					occurredAt,
				})
				.returning();

			const [rev] = insertedRevs;
			if (!rev) {
				throw new BudgetError(
					"BUDGET_REVISION_CONFLICT",
					"failed to insert feedback revision",
				);
			}

			return {
				instance,
				revision: formatRevisionResult(rev),
			};
		} catch (err: unknown) {
			if (isUniqueViolationOnConstraint(err, "bv2recfb_user_idempotency_idx")) {
				// Concurrently inserted under this idempotency key: re-fetch and check exact command identity
				const raceRevs = await tx
					.select()
					.from(budgetV2RecommendationFeedbackRevisions)
					.where(
						and(
							eq(budgetV2RecommendationFeedbackRevisions.userId, userId),
							eq(
								budgetV2RecommendationFeedbackRevisions.idempotencyKey,
								idempotencyKey,
							),
						),
					)
					.limit(1);
				const [raceRev] = raceRevs;
				if (raceRev) {
					await verifyStoredBudgetV2RecommendationFeedbackRevision(raceRev);
					const sameRec = instance.recommendationId === recommendationId;
					const samePaymentEvent =
						instance.paymentEventId === throughPaymentEventId;
					const sameFingerprint =
						expectedRecommendationFingerprint ===
						instance.recommendationFingerprint;
					const sameDecision = raceRev.decision === decision;
					const sameOp = raceRev.operation === "CREATE";
					const sameMod =
						canonicalJsonStringify(raceRev.modificationJson ?? null) ===
						canonicalJsonStringify(normalizedMod ?? null);
					const sameOccurredAt =
						new Date(raceRev.occurredAt).getTime() === occurredAt.getTime();

					if (
						sameRec &&
						samePaymentEvent &&
						sameFingerprint &&
						sameDecision &&
						sameOp &&
						sameMod &&
						sameOccurredAt
					) {
						return {
							instance,
							revision: formatRevisionResult(raceRev),
						};
					}
				}
				throw new BudgetError(
					"BUDGET_IDEMPOTENCY_CONFLICT",
					`idempotency key '${idempotencyKey}' already exists`,
				);
			}

			if (isUniqueViolationOnConstraint(err, "bv2recfb_instance_rev_no_idx")) {
				throw new BudgetError(
					"BUDGET_REVISION_CONFLICT",
					"feedback revision conflict for recommendation instance",
				);
			}

			throw err;
		}
	});
}

// ============================================================================
// Service: updateBudgetV2RecommendationFeedback
// ============================================================================

export async function updateBudgetV2RecommendationFeedback(
	db: Database,
	input: UpdateBudgetV2RecommendationFeedbackInput,
): Promise<BudgetV2RecommendationFeedbackResult> {
	const userId = input.userId?.trim();
	const recommendationId = input.recommendationId?.trim();
	const expectedRevisionNo = input.expectedRevisionNo;
	const idempotencyKey = input.idempotencyKey?.trim();
	const decision = input.decision;
	const occurredAt = validateFiniteDate(input.occurredAt, "occurredAt");

	if (
		!userId ||
		!recommendationId ||
		expectedRevisionNo === undefined ||
		expectedRevisionNo < 1 ||
		!idempotencyKey
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"missing or invalid required input fields for updateBudgetV2RecommendationFeedback",
		);
	}

	if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"idempotencyKey must be 1..128 characters",
		);
	}

	if (!["ACCEPT", "MODIFY", "IGNORE"].includes(decision)) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`invalid decision '${decision}'`,
		);
	}

	// 1. Fast historical idempotency lookup
	const existingRevs = await db
		.select()
		.from(budgetV2RecommendationFeedbackRevisions)
		.where(
			and(
				eq(budgetV2RecommendationFeedbackRevisions.userId, userId),
				eq(
					budgetV2RecommendationFeedbackRevisions.idempotencyKey,
					idempotencyKey,
				),
			),
		)
		.limit(1);

	const [existingRev] = existingRevs;
	if (existingRev) {
		const instRows = await db
			.select()
			.from(budgetV2RecommendationInstances)
			.where(
				eq(
					budgetV2RecommendationInstances.id,
					existingRev.recommendationInstanceId,
				),
			)
			.limit(1);

		const [inst] = instRows;
		if (!inst) {
			throw new BudgetError(
				"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
				"stored feedback revision references missing recommendation instance",
			);
		}

		await verifyStoredBudgetV2RecommendationInstance(inst);
		await verifyStoredBudgetV2RecommendationFeedbackRevision(existingRev);

		// Normalize retry input modification AGAINST THE FROZEN recommendation instance
		const frozenRec = inst.recommendationJson as BudgetV2Recommendation;
		const normalizedRetryMod = validateAndNormalizeModification(
			decision,
			input.modification,
			frozenRec,
		);

		// Full UPDATE command identity verification
		const sameRec = inst.recommendationId === recommendationId;
		const sameExpectedRevision =
			existingRev.revisionNo - 1 === expectedRevisionNo;
		const sameDecision = existingRev.decision === decision;
		const sameOp = existingRev.operation === "UPDATE";
		const sameMod =
			canonicalJsonStringify(existingRev.modificationJson ?? null) ===
			canonicalJsonStringify(normalizedRetryMod ?? null);
		const sameOccurredAt =
			new Date(existingRev.occurredAt).getTime() === occurredAt.getTime();

		if (
			sameRec &&
			sameExpectedRevision &&
			sameDecision &&
			sameOp &&
			sameMod &&
			sameOccurredAt
		) {
			return {
				instance: inst,
				revision: formatRevisionResult(existingRev),
			};
		}

		throw new BudgetError(
			"BUDGET_IDEMPOTENCY_CONFLICT",
			`idempotency key '${idempotencyKey}' already used with different payload`,
		);
	}

	// 2. Transaction execution
	return await db.transaction(async (tx) => {
		// Lock recommendation instance
		const instRows = await tx
			.select()
			.from(budgetV2RecommendationInstances)
			.where(
				and(
					eq(budgetV2RecommendationInstances.userId, userId),
					eq(
						budgetV2RecommendationInstances.recommendationId,
						recommendationId,
					),
				),
			)
			.for("update")
			.limit(1);

		const [instance] = instRows;
		if (!instance) {
			throw new BudgetError(
				"BUDGET_RECOMMENDATION_NOT_FOUND",
				`recommendation instance '${recommendationId}' not found`,
			);
		}

		await verifyStoredBudgetV2RecommendationInstance(instance);

		// Second idempotency check inside transaction
		const txExistingRevs = await tx
			.select()
			.from(budgetV2RecommendationFeedbackRevisions)
			.where(
				and(
					eq(budgetV2RecommendationFeedbackRevisions.userId, userId),
					eq(
						budgetV2RecommendationFeedbackRevisions.idempotencyKey,
						idempotencyKey,
					),
				),
			)
			.limit(1);

		const [txExistingRev] = txExistingRevs;
		if (txExistingRev) {
			await verifyStoredBudgetV2RecommendationFeedbackRevision(txExistingRev);
			const frozenRec = instance.recommendationJson as BudgetV2Recommendation;
			const normalizedRetryMod = validateAndNormalizeModification(
				decision,
				input.modification,
				frozenRec,
			);

			const sameRec = instance.recommendationId === recommendationId;
			const sameExpectedRevision =
				txExistingRev.revisionNo - 1 === expectedRevisionNo;
			const sameDecision = txExistingRev.decision === decision;
			const sameOp = txExistingRev.operation === "UPDATE";
			const sameMod =
				canonicalJsonStringify(txExistingRev.modificationJson ?? null) ===
				canonicalJsonStringify(normalizedRetryMod ?? null);
			const sameOccurredAt =
				new Date(txExistingRev.occurredAt).getTime() === occurredAt.getTime();

			if (
				sameRec &&
				sameExpectedRevision &&
				sameDecision &&
				sameOp &&
				sameMod &&
				sameOccurredAt
			) {
				return {
					instance,
					revision: formatRevisionResult(txExistingRev),
				};
			}
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`idempotency key '${idempotencyKey}' already used with different payload`,
			);
		}

		// Load latest feedback revision
		const latestRevs = await tx
			.select()
			.from(budgetV2RecommendationFeedbackRevisions)
			.where(
				eq(
					budgetV2RecommendationFeedbackRevisions.recommendationInstanceId,
					instance.id,
				),
			)
			.orderBy(desc(budgetV2RecommendationFeedbackRevisions.revisionNo))
			.for("update")
			.limit(1);

		const [latestRev] = latestRevs;
		if (!latestRev) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`no prior feedback revision found for recommendation instance '${recommendationId}'`,
			);
		}

		await verifyStoredBudgetV2RecommendationFeedbackRevision(latestRev);

		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`expected revision ${expectedRevisionNo}, but current revision is ${latestRev.revisionNo}`,
			);
		}

		// Validate against FROZEN recommendation instance
		const frozenRec = instance.recommendationJson as BudgetV2Recommendation;
		const normalizedMod = validateAndNormalizeModification(
			decision,
			input.modification,
			frozenRec,
		);

		// Validate strict temporal monotonicity
		if (occurredAt.getTime() <= new Date(latestRev.occurredAt).getTime()) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`feedback update occurredAt (${occurredAt.toISOString()}) must be strictly after previous revision occurredAt (${new Date(latestRev.occurredAt).toISOString()})`,
			);
		}

		const nextRevisionNo = latestRev.revisionNo + 1;
		const revisionFingerprint = await calculateFeedbackRevisionFingerprint({
			userId,
			recommendationInstanceId: instance.id,
			operation: "UPDATE",
			revisionNo: nextRevisionNo,
			previousRevisionId: latestRev.id,
			decision,
			modificationJson: normalizedMod,
			sourceKind: "USER_APPROVED",
			occurredAt,
		});

		try {
			const insertedRevs = await tx
				.insert(budgetV2RecommendationFeedbackRevisions)
				.values({
					userId,
					recommendationInstanceId: instance.id,
					revisionNo: nextRevisionNo,
					previousRevisionId: latestRev.id,
					operation: "UPDATE",
					decision,
					modificationJson: normalizedMod,
					sourceKind: "USER_APPROVED",
					idempotencyKey,
					revisionFingerprint,
					occurredAt,
				})
				.returning();

			const [rev] = insertedRevs;
			if (!rev) {
				throw new BudgetError(
					"BUDGET_REVISION_CONFLICT",
					"failed to insert feedback revision",
				);
			}

			return {
				instance,
				revision: formatRevisionResult(rev),
			};
		} catch (err: unknown) {
			if (isUniqueViolationOnConstraint(err, "bv2recfb_user_idempotency_idx")) {
				const raceRevs = await tx
					.select()
					.from(budgetV2RecommendationFeedbackRevisions)
					.where(
						and(
							eq(budgetV2RecommendationFeedbackRevisions.userId, userId),
							eq(
								budgetV2RecommendationFeedbackRevisions.idempotencyKey,
								idempotencyKey,
							),
						),
					)
					.limit(1);
				const [raceRev] = raceRevs;
				if (raceRev) {
					await verifyStoredBudgetV2RecommendationFeedbackRevision(raceRev);
					const sameRec = instance.recommendationId === recommendationId;
					const sameExpectedRevision =
						raceRev.revisionNo - 1 === expectedRevisionNo;
					const sameDecision = raceRev.decision === decision;
					const sameOp = raceRev.operation === "UPDATE";
					const sameMod =
						canonicalJsonStringify(raceRev.modificationJson ?? null) ===
						canonicalJsonStringify(normalizedMod ?? null);
					const sameOccurredAt =
						new Date(raceRev.occurredAt).getTime() === occurredAt.getTime();

					if (
						sameRec &&
						sameExpectedRevision &&
						sameDecision &&
						sameOp &&
						sameMod &&
						sameOccurredAt
					) {
						return {
							instance,
							revision: formatRevisionResult(raceRev),
						};
					}
				}
				throw new BudgetError(
					"BUDGET_IDEMPOTENCY_CONFLICT",
					`idempotency key '${idempotencyKey}' already exists`,
				);
			}

			if (
				isUniqueViolationOnConstraint(err, "bv2recfb_instance_rev_no_idx") ||
				isUniqueViolationOnConstraint(err, "bv2recfb_prev_idx")
			) {
				throw new BudgetError(
					"BUDGET_REVISION_CONFLICT",
					"concurrent revision conflict on recommendation feedback",
				);
			}

			throw err;
		}
	});
}

// ============================================================================
// Service: getBudgetV2RecommendationFeedbackAsOf
// ============================================================================

export async function getBudgetV2RecommendationFeedbackAsOf(params: {
	db: Database;
	userId: string;
	recommendationId: string;
	asOf: Date;
}): Promise<BudgetV2RecommendationFeedbackAsOfResult> {
	const asOf = validateFiniteDate(params.asOf, "asOf");

	const instRows = await params.db
		.select()
		.from(budgetV2RecommendationInstances)
		.where(
			and(
				eq(budgetV2RecommendationInstances.userId, params.userId),
				eq(
					budgetV2RecommendationInstances.recommendationId,
					params.recommendationId,
				),
			),
		)
		.limit(1);

	const [instance] = instRows;
	if (!instance) {
		return {
			recommendation: null,
			feedback: null,
			status: "UNRESPONDED",
		};
	}

	await verifyStoredBudgetV2RecommendationInstance(instance);

	// Section 7: Temporal point-in-time check. If asOf is before instance capturedAt,
	// do NOT leak the future recommendation instance.
	if (asOf.getTime() < new Date(instance.capturedAt).getTime()) {
		return {
			recommendation: null,
			feedback: null,
			status: "UNRESPONDED",
		};
	}

	const revs = await params.db
		.select()
		.from(budgetV2RecommendationFeedbackRevisions)
		.where(
			and(
				eq(
					budgetV2RecommendationFeedbackRevisions.recommendationInstanceId,
					instance.id,
				),
				lte(budgetV2RecommendationFeedbackRevisions.occurredAt, asOf),
			),
		)
		.orderBy(
			desc(budgetV2RecommendationFeedbackRevisions.occurredAt),
			desc(budgetV2RecommendationFeedbackRevisions.revisionNo),
		)
		.limit(1);

	const [rev] = revs;
	if (!rev) {
		return {
			recommendation: instance,
			feedback: null,
			status: "UNRESPONDED",
		};
	}

	await verifyStoredBudgetV2RecommendationFeedbackRevision(rev);

	return {
		recommendation: instance,
		feedback: formatRevisionResult(rev),
		status: rev.decision as "ACCEPT" | "MODIFY" | "IGNORE",
	};
}

/**
 * Convenience helper to read the latest feedback for a recommendation.
 */
export async function getLatestBudgetV2RecommendationFeedback(params: {
	db: Database;
	userId: string;
	recommendationId: string;
}): Promise<BudgetV2RecommendationFeedbackAsOfResult> {
	return getBudgetV2RecommendationFeedbackAsOf({
		...params,
		asOf: new Date(8640000000000000), // Max Date
	});
}

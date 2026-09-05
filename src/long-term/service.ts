import { and, asc, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	longTermSendTaskRevisions,
	longTermSendTasks,
} from "../db/schema/long-term";
import { midasAccounts, midasBuckets } from "../db/schema/midas";
import { transactionRevisions } from "../db/schema/transactions";
import { lockLedgerAccountsInTransaction } from "../ledger/posting";
import {
	createMidasAllocationTransferInTransaction,
	lockMidasAllocationStateInTransaction,
} from "../midas/service";
import {
	createCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import { runLongTermReadTransaction, runLongTermTransaction } from "./boundary";
import {
	validateLongTermCanonicalUuid,
	validateLongTermExpectedRevisionNo,
	validateLongTermIdempotencyKey,
	validateLongTermOccurredAt,
	validateLongTermOptionalText,
	validateLongTermPositiveMoney,
	validateLongTermTaskStatusFilter,
} from "./calendar";
import { LongTermError } from "./errors";
import {
	calculateLongTermTaskCreateFingerprint,
	calculateLongTermTaskLifecycleFingerprint,
	deriveLongTermChildIdempotencyKey,
} from "./fingerprint";
import { ensureLongTermExternalCostAccountInTransaction } from "./ledger-provisioning";

type LongTermTaskStatus = "PENDING" | "SENT" | "CANCELLED";
type LongTermTaskOperation = "CREATE" | "SENT" | "REOPEN" | "CANCEL";

export interface LongTermTaskReadModel {
	taskId: string;
	status: LongTermTaskStatus;
	revisionNo: number;
	amount: string;
	destinationLabel: string | null;
	note: string | null;
	midasAccountId: string;
	pendingBucketId: string;
	allocatedAt: Date;
	sentAt: Date | null;
	latestMidasAllocationTransferId: string;
	currentSendCanonicalTransactionId: string | null;
	currentSendCanonicalRevisionId: string | null;
	createdAt: Date;
}

export interface AllocateLongTermInvestmentParams {
	db: Database;
	userId: string;
	midasAccountId: string;
	amount: string;
	destinationLabel?: string | null | undefined;
	note?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface MarkLongTermInvestmentSentParams {
	db: Database;
	userId: string;
	taskId: string;
	expectedRevisionNo: number;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface ReopenLongTermInvestmentSendParams {
	db: Database;
	userId: string;
	taskId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface CancelLongTermInvestmentTaskParams {
	db: Database;
	userId: string;
	taskId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface GetLongTermInvestmentTaskParams {
	db: Database;
	userId: string;
	taskId: string;
}

export interface ListLongTermInvestmentTasksParams {
	db: Database;
	userId: string;
	status?: LongTermTaskStatus | undefined;
	midasAccountId?: string | undefined;
}

// ============================================================================
// Read Model Construction
// ============================================================================

/**
 * Builds the task read model AS OF a specific revision -- not the latest
 * state. This is the authoritative snapshot builder: both the live
 * (latest-revision) read path and historical idempotency replay funnel
 * through this same function, so a replay of an old key can never
 * accidentally surface current/latest state instead of the historical
 * operation's own snapshot.
 */
async function buildLongTermTaskReadModelForRevisionInTransaction(
	tx: DatabaseTransaction,
	taskId: string,
	revision: typeof longTermSendTaskRevisions.$inferSelect,
): Promise<LongTermTaskReadModel | null> {
	const [task] = await tx
		.select()
		.from(longTermSendTasks)
		.where(eq(longTermSendTasks.id, taskId))
		.limit(1);
	if (!task) return null;

	const [createRev] = await tx
		.select({ occurredAt: longTermSendTaskRevisions.occurredAt })
		.from(longTermSendTaskRevisions)
		.where(
			and(
				eq(longTermSendTaskRevisions.taskId, taskId),
				eq(longTermSendTaskRevisions.revisionNo, 1),
			),
		)
		.limit(1);

	const status = revision.status as LongTermTaskStatus;
	let currentSendCanonicalTransactionId: string | null = null;
	let currentSendCanonicalRevisionId: string | null = null;
	let sentAt: Date | null = null;

	if (status === "SENT" && revision.canonicalRevisionId) {
		sentAt = revision.occurredAt;
		currentSendCanonicalRevisionId = revision.canonicalRevisionId;
		const [canRev] = await tx
			.select({ transactionId: transactionRevisions.transactionId })
			.from(transactionRevisions)
			.where(eq(transactionRevisions.id, revision.canonicalRevisionId))
			.limit(1);
		currentSendCanonicalTransactionId = canRev?.transactionId ?? null;
	}

	return {
		taskId: task.id,
		status,
		revisionNo: revision.revisionNo,
		amount: revision.amount,
		destinationLabel: revision.destinationLabel,
		note: revision.note,
		midasAccountId: task.midasAccountId,
		pendingBucketId: task.pendingBucketId,
		allocatedAt: createRev?.occurredAt ?? task.createdAt,
		sentAt,
		latestMidasAllocationTransferId: revision.midasAllocationTransferId,
		currentSendCanonicalTransactionId,
		currentSendCanonicalRevisionId,
		createdAt: task.createdAt,
	};
}

async function buildLongTermTaskReadModelInTransaction(
	tx: DatabaseTransaction,
	taskId: string,
): Promise<LongTermTaskReadModel | null> {
	const [latestRev] = await tx
		.select()
		.from(longTermSendTaskRevisions)
		.where(eq(longTermSendTaskRevisions.taskId, taskId))
		.orderBy(desc(longTermSendTaskRevisions.revisionNo))
		.limit(1);
	if (!latestRev) return null;

	return buildLongTermTaskReadModelForRevisionInTransaction(
		tx,
		taskId,
		latestRev,
	);
}

// ============================================================================
// Shared internal helpers
// ============================================================================

async function findExistingRevisionByIdempotencyKeyInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	idempotencyKey: string,
): Promise<typeof longTermSendTaskRevisions.$inferSelect | undefined> {
	const [row] = await tx
		.select()
		.from(longTermSendTaskRevisions)
		.where(
			and(
				eq(longTermSendTaskRevisions.userId, userId),
				eq(longTermSendTaskRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	return row;
}

async function tryReplayLifecycleInTransaction(
	tx: DatabaseTransaction,
	existingRev: typeof longTermSendTaskRevisions.$inferSelect,
	args: {
		userId: string;
		taskId: string;
		operation: "SENT" | "REOPEN" | "CANCEL";
		expectedRevisionNo: number;
		occurredAt: Date;
		reasonNote: string | null;
	},
): Promise<{ task: LongTermTaskReadModel; idempotentReplay: boolean } | null> {
	if (
		existingRev.taskId !== args.taskId ||
		existingRev.operation !== args.operation
	) {
		throw new LongTermError(
			"LONG_TERM_IDEMPOTENCY_CONFLICT",
			"Idempotency key was already used for a different long-term task or operation",
		);
	}
	const candidateFingerprint = await calculateLongTermTaskLifecycleFingerprint({
		userId: args.userId,
		taskId: args.taskId,
		operation: args.operation,
		expectedRevisionNo: args.expectedRevisionNo,
		occurredAt: args.occurredAt,
		reasonNote: args.reasonNote,
	});
	if (candidateFingerprint !== existingRev.revisionFingerprint) {
		throw new LongTermError(
			"LONG_TERM_IDEMPOTENCY_CONFLICT",
			`Idempotency key reused with a different long-term ${args.operation} payload`,
		);
	}
	// Return the HISTORICAL snapshot owned by this key -- not whatever the
	// task's current/latest state happens to be. A SENT #1 key retried
	// after a REOPEN must still report SENT/rev2, never the task's current
	// PENDING state.
	const task = await buildLongTermTaskReadModelForRevisionInTransaction(
		tx,
		args.taskId,
		existingRev,
	);
	if (!task) {
		throw new LongTermError(
			"LONG_TERM_INVALID_STATE",
			"Failed to build replayed long-term task read model",
		);
	}
	return { task, idempotentReplay: true };
}

// ============================================================================
// CREATE / ALLOCATE
// ============================================================================

export interface AllocateLongTermInvestmentInTransactionArgs {
	userId: string;
	midasAccountId: string;
	amount: string;
	destinationLabel: string | null;
	note: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

/**
 * Internal transaction-scoped primitive for allocating long-term investment
 * funds (UNALLOCATED -> PENDING_LONG_TERM, virtual earmarking only -- NO
 * financial journal). Does NOT call db.transaction(). Exposed for future
 * Phase 14 / other backend coordination. Callers must pass already-validated
 * arguments (canonical UUIDs, normalized money strings, a valid Date).
 */
export async function allocateLongTermInvestmentInTransaction(
	tx: DatabaseTransaction,
	args: AllocateLongTermInvestmentInTransactionArgs,
): Promise<{ task: LongTermTaskReadModel; idempotentReplay: boolean }> {
	const earlyRev = await findExistingRevisionByIdempotencyKeyInTransaction(
		tx,
		args.userId,
		args.idempotencyKey,
	);
	const tryReplayCreate = async (
		existingRev: typeof longTermSendTaskRevisions.$inferSelect,
	) => {
		if (existingRev.revisionNo !== 1 || existingRev.operation !== "CREATE") {
			throw new LongTermError(
				"LONG_TERM_IDEMPOTENCY_CONFLICT",
				"Idempotency key was already used for a different long-term task operation",
			);
		}
		const candidateFingerprint = await calculateLongTermTaskCreateFingerprint({
			userId: args.userId,
			midasAccountId: args.midasAccountId,
			amount: args.amount,
			destinationLabel: args.destinationLabel,
			note: args.note,
			occurredAt: args.occurredAt,
		});
		if (candidateFingerprint !== existingRev.revisionFingerprint) {
			throw new LongTermError(
				"LONG_TERM_IDEMPOTENCY_CONFLICT",
				"Idempotency key reused with a different long-term CREATE payload",
			);
		}
		// Historical CREATE snapshot (revision #1/PENDING) -- even if the
		// task has since been SENT/REOPENED/CANCELLED.
		const task = await buildLongTermTaskReadModelForRevisionInTransaction(
			tx,
			existingRev.taskId,
			existingRev,
		);
		if (!task) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Failed to build replayed long-term task read model",
			);
		}
		return { task, idempotentReplay: true as const };
	};

	if (earlyRev) return tryReplayCreate(earlyRev);

	// Global lock order: ledger_accounts (none needed for CREATE) -> Midas
	// account (via the shared allocation-state lock) -> task (none exists
	// yet for a fresh CREATE).
	await lockMidasAllocationStateInTransaction({
		tx,
		userId: args.userId,
		midasAccountId: args.midasAccountId,
	});

	const secondRev = await findExistingRevisionByIdempotencyKeyInTransaction(
		tx,
		args.userId,
		args.idempotencyKey,
	);
	if (secondRev) return tryReplayCreate(secondRev);

	const [bucket] = await tx
		.select({ id: midasBuckets.id })
		.from(midasBuckets)
		.where(
			and(
				eq(midasBuckets.midasAccountId, args.midasAccountId),
				eq(midasBuckets.bucketType, "PENDING_LONG_TERM"),
			),
		)
		.limit(1);
	if (!bucket) {
		throw new LongTermError(
			"LONG_TERM_INVALID_STATE",
			`No PENDING_LONG_TERM bucket exists for Midas account "${args.midasAccountId}"`,
		);
	}

	const taskId = crypto.randomUUID();
	const childTransferKey = await deriveLongTermChildIdempotencyKey(
		args.idempotencyKey,
		[args.midasAccountId, "CREATE", "transfer"],
	);

	const transferRes = await createMidasAllocationTransferInTransaction({
		tx,
		userId: args.userId,
		midasAccountId: args.midasAccountId,
		idempotencyKey: childTransferKey,
		fromBucketId: null,
		toBucketId: bucket.id,
		amount: args.amount,
		occurredAt: args.occurredAt,
		memo: "Long-term investment allocation",
	});

	const [insertedTask] = await tx
		.insert(longTermSendTasks)
		.values({
			id: taskId,
			userId: args.userId,
			midasAccountId: args.midasAccountId,
			pendingBucketId: bucket.id,
		})
		.returning();
	if (!insertedTask) {
		throw new LongTermError(
			"LONG_TERM_INVALID_STATE",
			"Failed to create long-term send task",
		);
	}

	const fingerprint = await calculateLongTermTaskCreateFingerprint({
		userId: args.userId,
		midasAccountId: args.midasAccountId,
		amount: args.amount,
		destinationLabel: args.destinationLabel,
		note: args.note,
		occurredAt: args.occurredAt,
	});

	await tx.insert(longTermSendTaskRevisions).values({
		userId: args.userId,
		taskId: insertedTask.id,
		revisionNo: 1,
		previousRevisionId: null,
		operation: "CREATE",
		status: "PENDING",
		amount: args.amount,
		destinationLabel: args.destinationLabel,
		note: args.note,
		reasonNote: null,
		midasAllocationTransferId: transferRes.transferId,
		canonicalRevisionId: null,
		occurredAt: args.occurredAt,
		idempotencyKey: args.idempotencyKey,
		revisionFingerprint: fingerprint,
	});

	const task = await buildLongTermTaskReadModelInTransaction(
		tx,
		insertedTask.id,
	);
	if (!task) {
		throw new LongTermError(
			"LONG_TERM_INVALID_STATE",
			"Failed to build newly created long-term task read model",
		);
	}
	return { task, idempotentReplay: false };
}

export async function allocateLongTermInvestment(
	params: AllocateLongTermInvestmentParams,
): Promise<{ task: LongTermTaskReadModel; idempotentReplay: boolean }> {
	const userId = validateLongTermCanonicalUuid(params.userId, "userId");
	const midasAccountId = validateLongTermCanonicalUuid(
		params.midasAccountId,
		"midasAccountId",
	);
	const amount = validateLongTermPositiveMoney(
		params.amount,
		"amount",
	).normalized;
	const destinationLabel = validateLongTermOptionalText(
		params.destinationLabel,
		"destinationLabel",
		120,
	);
	const note = validateLongTermOptionalText(params.note, "note", 500);
	const occurredAt = validateLongTermOccurredAt(params.occurredAt);
	const idempotencyKey = validateLongTermIdempotencyKey(params.idempotencyKey);

	return runLongTermTransaction(params.db, (tx) =>
		allocateLongTermInvestmentInTransaction(tx, {
			userId,
			midasAccountId,
			amount,
			destinationLabel,
			note,
			occurredAt,
			idempotencyKey,
		}),
	);
}

// ============================================================================
// SENT
// ============================================================================

export async function markLongTermInvestmentSent(
	params: MarkLongTermInvestmentSentParams,
): Promise<{ task: LongTermTaskReadModel; idempotentReplay: boolean }> {
	const userId = validateLongTermCanonicalUuid(params.userId, "userId");
	const taskId = validateLongTermCanonicalUuid(params.taskId, "taskId");
	const expectedRevisionNo = validateLongTermExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const occurredAt = validateLongTermOccurredAt(params.occurredAt);
	const idempotencyKey = validateLongTermIdempotencyKey(params.idempotencyKey);

	return runLongTermTransaction(params.db, async (tx) => {
		const earlyRev = await findExistingRevisionByIdempotencyKeyInTransaction(
			tx,
			userId,
			idempotencyKey,
		);
		if (earlyRev) {
			const replay = await tryReplayLifecycleInTransaction(tx, earlyRev, {
				userId,
				taskId,
				operation: "SENT",
				expectedRevisionNo,
				occurredAt,
				reasonNote: null,
			});
			if (replay) return replay;
		}

		const [taskPeek] = await tx
			.select()
			.from(longTermSendTasks)
			.where(
				and(
					eq(longTermSendTasks.id, taskId),
					eq(longTermSendTasks.userId, userId),
				),
			)
			.limit(1);
		if (!taskPeek) {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_FOUND",
				`Long-term send task "${taskId}" not found`,
			);
		}

		// Lock order: provision/resolve required ledger accounts -> lock ALL
		// required ledger accounts sorted by id -> lock Midas account -> lock
		// task -> second replay -> mutation.
		const externalCostAccountId =
			await ensureLongTermExternalCostAccountInTransaction(tx, userId);
		const [midasAccountRow] = await tx
			.select({ ledgerAccountId: midasAccounts.ledgerAccountId })
			.from(midasAccounts)
			.where(eq(midasAccounts.id, taskPeek.midasAccountId))
			.limit(1);
		if (!midasAccountRow) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Midas account for this task no longer exists",
			);
		}

		await lockLedgerAccountsInTransaction({
			tx,
			userId,
			accountIds: [externalCostAccountId, midasAccountRow.ledgerAccountId],
		});
		await lockMidasAllocationStateInTransaction({
			tx,
			userId,
			midasAccountId: taskPeek.midasAccountId,
		});
		const [task] = await tx
			.select()
			.from(longTermSendTasks)
			.where(
				and(
					eq(longTermSendTasks.id, taskId),
					eq(longTermSendTasks.userId, userId),
				),
			)
			.for("update")
			.limit(1);
		if (!task) {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_FOUND",
				`Long-term send task "${taskId}" not found`,
			);
		}

		const secondRev = await findExistingRevisionByIdempotencyKeyInTransaction(
			tx,
			userId,
			idempotencyKey,
		);
		if (secondRev) {
			const replay = await tryReplayLifecycleInTransaction(tx, secondRev, {
				userId,
				taskId,
				operation: "SENT",
				expectedRevisionNo,
				occurredAt,
				reasonNote: null,
			});
			if (replay) return replay;
		}

		const [latestRev] = await tx
			.select()
			.from(longTermSendTaskRevisions)
			.where(eq(longTermSendTaskRevisions.taskId, taskId))
			.orderBy(desc(longTermSendTaskRevisions.revisionNo))
			.limit(1);
		if (!latestRev) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Long-term send task has no revisions",
			);
		}
		if (latestRev.status === "CANCELLED") {
			throw new LongTermError(
				"LONG_TERM_TASK_CANCELLED",
				`Long-term send task "${taskId}" is CANCELLED`,
			);
		}
		if (latestRev.status !== "PENDING") {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_PENDING",
				`Long-term send task "${taskId}" is not PENDING (status: ${latestRev.status})`,
			);
		}
		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new LongTermError(
				"LONG_TERM_REVISION_CONFLICT",
				`Expected long-term task revision ${expectedRevisionNo} but found ${latestRev.revisionNo}`,
			);
		}

		const childTransferKey = await deriveLongTermChildIdempotencyKey(
			idempotencyKey,
			[taskId, "SENT", "transfer"],
		);
		const transferRes = await createMidasAllocationTransferInTransaction({
			tx,
			userId,
			midasAccountId: task.midasAccountId,
			idempotencyKey: childTransferKey,
			fromBucketId: task.pendingBucketId,
			toBucketId: null,
			amount: latestRev.amount,
			occurredAt,
			memo: "Long-term investment send",
		});

		const canonicalPayload: Record<string, unknown> = {
			taskId,
			midasAccountId: task.midasAccountId,
			pendingBucketId: task.pendingBucketId,
			amount: latestRev.amount,
			destinationLabel: latestRev.destinationLabel,
			note: latestRev.note,
		};

		const childCanonicalKey = await deriveLongTermChildIdempotencyKey(
			idempotencyKey,
			[taskId, "SENT", "canonical"],
		);
		const boundRes = await createCanonicalTransactionWithLedgerInTransaction({
			tx,
			userId,
			kind: "LONG_TERM_INVESTMENT_SEND",
			idempotencyKey: childCanonicalKey,
			occurredAt,
			payload: canonicalPayload,
			source: { type: "LONG_TERM_INVESTMENT_SEND", ref: childCanonicalKey },
			ledger: {
				memo: "Long-term investment send",
				lines: [
					{
						accountId: externalCostAccountId,
						side: "DEBIT",
						amount: latestRev.amount,
					},
					{
						accountId: midasAccountRow.ledgerAccountId,
						side: "CREDIT",
						amount: latestRev.amount,
					},
				],
			},
		});

		const fingerprint = await calculateLongTermTaskLifecycleFingerprint({
			userId,
			taskId,
			operation: "SENT",
			expectedRevisionNo,
			occurredAt,
			reasonNote: null,
		});

		await tx.insert(longTermSendTaskRevisions).values({
			userId,
			taskId,
			revisionNo: latestRev.revisionNo + 1,
			previousRevisionId: latestRev.id,
			operation: "SENT",
			status: "SENT",
			amount: latestRev.amount,
			destinationLabel: latestRev.destinationLabel,
			note: latestRev.note,
			reasonNote: null,
			midasAllocationTransferId: transferRes.transferId,
			canonicalRevisionId: boundRes.revisionId,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: fingerprint,
		});

		const result = await buildLongTermTaskReadModelInTransaction(tx, taskId);
		if (!result) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Failed to build sent long-term task read model",
			);
		}
		return { task: result, idempotentReplay: false };
	});
}

// ============================================================================
// REOPEN
// ============================================================================

export async function reopenLongTermInvestmentSend(
	params: ReopenLongTermInvestmentSendParams,
): Promise<{ task: LongTermTaskReadModel; idempotentReplay: boolean }> {
	const userId = validateLongTermCanonicalUuid(params.userId, "userId");
	const taskId = validateLongTermCanonicalUuid(params.taskId, "taskId");
	const expectedRevisionNo = validateLongTermExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const reasonNote = validateLongTermOptionalText(
		params.reasonNote,
		"reasonNote",
		500,
	);
	const occurredAt = validateLongTermOccurredAt(params.occurredAt);
	const idempotencyKey = validateLongTermIdempotencyKey(params.idempotencyKey);

	return runLongTermTransaction(params.db, async (tx) => {
		const earlyRev = await findExistingRevisionByIdempotencyKeyInTransaction(
			tx,
			userId,
			idempotencyKey,
		);
		if (earlyRev) {
			const replay = await tryReplayLifecycleInTransaction(tx, earlyRev, {
				userId,
				taskId,
				operation: "REOPEN",
				expectedRevisionNo,
				occurredAt,
				reasonNote,
			});
			if (replay) return replay;
		}

		const [taskPeek] = await tx
			.select()
			.from(longTermSendTasks)
			.where(
				and(
					eq(longTermSendTasks.id, taskId),
					eq(longTermSendTasks.userId, userId),
				),
			)
			.limit(1);
		if (!taskPeek) {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_FOUND",
				`Long-term send task "${taskId}" not found`,
			);
		}

		const externalCostAccountId =
			await ensureLongTermExternalCostAccountInTransaction(tx, userId);
		const [midasAccountRow] = await tx
			.select({ ledgerAccountId: midasAccounts.ledgerAccountId })
			.from(midasAccounts)
			.where(eq(midasAccounts.id, taskPeek.midasAccountId))
			.limit(1);
		if (!midasAccountRow) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Midas account for this task no longer exists",
			);
		}

		await lockLedgerAccountsInTransaction({
			tx,
			userId,
			accountIds: [externalCostAccountId, midasAccountRow.ledgerAccountId],
		});
		await lockMidasAllocationStateInTransaction({
			tx,
			userId,
			midasAccountId: taskPeek.midasAccountId,
		});
		const [task] = await tx
			.select()
			.from(longTermSendTasks)
			.where(
				and(
					eq(longTermSendTasks.id, taskId),
					eq(longTermSendTasks.userId, userId),
				),
			)
			.for("update")
			.limit(1);
		if (!task) {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_FOUND",
				`Long-term send task "${taskId}" not found`,
			);
		}

		const secondRev = await findExistingRevisionByIdempotencyKeyInTransaction(
			tx,
			userId,
			idempotencyKey,
		);
		if (secondRev) {
			const replay = await tryReplayLifecycleInTransaction(tx, secondRev, {
				userId,
				taskId,
				operation: "REOPEN",
				expectedRevisionNo,
				occurredAt,
				reasonNote,
			});
			if (replay) return replay;
		}

		const [latestRev] = await tx
			.select()
			.from(longTermSendTaskRevisions)
			.where(eq(longTermSendTaskRevisions.taskId, taskId))
			.orderBy(desc(longTermSendTaskRevisions.revisionNo))
			.limit(1);
		if (!latestRev) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Long-term send task has no revisions",
			);
		}
		if (latestRev.status === "CANCELLED") {
			throw new LongTermError(
				"LONG_TERM_TASK_CANCELLED",
				`Long-term send task "${taskId}" is CANCELLED`,
			);
		}
		if (latestRev.status !== "SENT") {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_SENT",
				`Long-term send task "${taskId}" is not SENT (status: ${latestRev.status})`,
			);
		}
		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new LongTermError(
				"LONG_TERM_REVISION_CONFLICT",
				`Expected long-term task revision ${expectedRevisionNo} but found ${latestRev.revisionNo}`,
			);
		}
		if (!latestRev.canonicalRevisionId) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"SENT revision is missing its canonical transaction binding",
			);
		}

		const [canRev] = await tx
			.select({
				transactionId: transactionRevisions.transactionId,
				revisionNo: transactionRevisions.revisionNo,
			})
			.from(transactionRevisions)
			.where(eq(transactionRevisions.id, latestRev.canonicalRevisionId))
			.limit(1);
		if (!canRev) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"SENT canonical revision could not be resolved",
			);
		}

		const childVoidKey = await deriveLongTermChildIdempotencyKey(
			idempotencyKey,
			[taskId, "REOPEN", "void"],
		);
		const voidRes = await voidCanonicalTransactionWithLedgerInTransaction({
			tx,
			userId,
			transactionId: canRev.transactionId,
			expectedRevisionNo: canRev.revisionNo,
			idempotencyKey: childVoidKey,
			reasonCode: "LONG_TERM_INVESTMENT_REOPEN",
			reasonNote: reasonNote ?? null,
			source: { type: "LONG_TERM_INVESTMENT_SEND", ref: childVoidKey },
		});

		const childTransferKey = await deriveLongTermChildIdempotencyKey(
			idempotencyKey,
			[taskId, "REOPEN", "transfer"],
		);
		const transferRes = await createMidasAllocationTransferInTransaction({
			tx,
			userId,
			midasAccountId: task.midasAccountId,
			idempotencyKey: childTransferKey,
			fromBucketId: null,
			toBucketId: task.pendingBucketId,
			amount: latestRev.amount,
			occurredAt,
			memo: "Long-term investment reopen (correction)",
		});

		const fingerprint = await calculateLongTermTaskLifecycleFingerprint({
			userId,
			taskId,
			operation: "REOPEN",
			expectedRevisionNo,
			occurredAt,
			reasonNote,
		});

		await tx.insert(longTermSendTaskRevisions).values({
			userId,
			taskId,
			revisionNo: latestRev.revisionNo + 1,
			previousRevisionId: latestRev.id,
			operation: "REOPEN",
			status: "PENDING",
			amount: latestRev.amount,
			destinationLabel: latestRev.destinationLabel,
			note: latestRev.note,
			reasonNote,
			midasAllocationTransferId: transferRes.transferId,
			canonicalRevisionId: voidRes.revisionId,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: fingerprint,
		});

		const result = await buildLongTermTaskReadModelInTransaction(tx, taskId);
		if (!result) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Failed to build reopened long-term task read model",
			);
		}
		return { task: result, idempotentReplay: false };
	});
}

// ============================================================================
// CANCEL
// ============================================================================

export async function cancelLongTermInvestmentTask(
	params: CancelLongTermInvestmentTaskParams,
): Promise<{ task: LongTermTaskReadModel; idempotentReplay: boolean }> {
	const userId = validateLongTermCanonicalUuid(params.userId, "userId");
	const taskId = validateLongTermCanonicalUuid(params.taskId, "taskId");
	const expectedRevisionNo = validateLongTermExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const reasonNote = validateLongTermOptionalText(
		params.reasonNote,
		"reasonNote",
		500,
	);
	const occurredAt = validateLongTermOccurredAt(params.occurredAt);
	const idempotencyKey = validateLongTermIdempotencyKey(params.idempotencyKey);

	return runLongTermTransaction(params.db, async (tx) => {
		const earlyRev = await findExistingRevisionByIdempotencyKeyInTransaction(
			tx,
			userId,
			idempotencyKey,
		);
		if (earlyRev) {
			const replay = await tryReplayLifecycleInTransaction(tx, earlyRev, {
				userId,
				taskId,
				operation: "CANCEL",
				expectedRevisionNo,
				occurredAt,
				reasonNote,
			});
			if (replay) return replay;
		}

		const [taskPeek] = await tx
			.select()
			.from(longTermSendTasks)
			.where(
				and(
					eq(longTermSendTasks.id, taskId),
					eq(longTermSendTasks.userId, userId),
				),
			)
			.limit(1);
		if (!taskPeek) {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_FOUND",
				`Long-term send task "${taskId}" not found`,
			);
		}

		// No ledger accounts required for CANCEL (no financial journal) --
		// only the Midas allocation-state lock is needed.
		await lockMidasAllocationStateInTransaction({
			tx,
			userId,
			midasAccountId: taskPeek.midasAccountId,
		});
		const [task] = await tx
			.select()
			.from(longTermSendTasks)
			.where(
				and(
					eq(longTermSendTasks.id, taskId),
					eq(longTermSendTasks.userId, userId),
				),
			)
			.for("update")
			.limit(1);
		if (!task) {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_FOUND",
				`Long-term send task "${taskId}" not found`,
			);
		}

		const secondRev = await findExistingRevisionByIdempotencyKeyInTransaction(
			tx,
			userId,
			idempotencyKey,
		);
		if (secondRev) {
			const replay = await tryReplayLifecycleInTransaction(tx, secondRev, {
				userId,
				taskId,
				operation: "CANCEL",
				expectedRevisionNo,
				occurredAt,
				reasonNote,
			});
			if (replay) return replay;
		}

		const [latestRev] = await tx
			.select()
			.from(longTermSendTaskRevisions)
			.where(eq(longTermSendTaskRevisions.taskId, taskId))
			.orderBy(desc(longTermSendTaskRevisions.revisionNo))
			.limit(1);
		if (!latestRev) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Long-term send task has no revisions",
			);
		}
		if (latestRev.status === "CANCELLED") {
			throw new LongTermError(
				"LONG_TERM_TASK_CANCELLED",
				`Long-term send task "${taskId}" is already CANCELLED`,
			);
		}
		if (latestRev.status !== "PENDING") {
			throw new LongTermError(
				"LONG_TERM_TASK_NOT_PENDING",
				`Long-term send task "${taskId}" is not PENDING (status: ${latestRev.status})`,
			);
		}
		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new LongTermError(
				"LONG_TERM_REVISION_CONFLICT",
				`Expected long-term task revision ${expectedRevisionNo} but found ${latestRev.revisionNo}`,
			);
		}

		const childTransferKey = await deriveLongTermChildIdempotencyKey(
			idempotencyKey,
			[taskId, "CANCEL", "transfer"],
		);
		const transferRes = await createMidasAllocationTransferInTransaction({
			tx,
			userId,
			midasAccountId: task.midasAccountId,
			idempotencyKey: childTransferKey,
			fromBucketId: task.pendingBucketId,
			toBucketId: null,
			amount: latestRev.amount,
			occurredAt,
			memo: "Long-term investment task cancelled",
		});

		const fingerprint = await calculateLongTermTaskLifecycleFingerprint({
			userId,
			taskId,
			operation: "CANCEL",
			expectedRevisionNo,
			occurredAt,
			reasonNote,
		});

		await tx.insert(longTermSendTaskRevisions).values({
			userId,
			taskId,
			revisionNo: latestRev.revisionNo + 1,
			previousRevisionId: latestRev.id,
			operation: "CANCEL",
			status: "CANCELLED",
			amount: latestRev.amount,
			destinationLabel: latestRev.destinationLabel,
			note: latestRev.note,
			reasonNote,
			midasAllocationTransferId: transferRes.transferId,
			canonicalRevisionId: null,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: fingerprint,
		});

		const result = await buildLongTermTaskReadModelInTransaction(tx, taskId);
		if (!result) {
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Failed to build cancelled long-term task read model",
			);
		}
		return { task: result, idempotentReplay: false };
	});
}

// ============================================================================
// Reads
// ============================================================================

export async function getLongTermInvestmentTask(
	params: GetLongTermInvestmentTaskParams,
): Promise<LongTermTaskReadModel | null> {
	const userId = validateLongTermCanonicalUuid(params.userId, "userId");
	const taskId = validateLongTermCanonicalUuid(params.taskId, "taskId");

	return runLongTermReadTransaction(params.db, async (tx) => {
		const [task] = await tx
			.select({ id: longTermSendTasks.id })
			.from(longTermSendTasks)
			.where(
				and(
					eq(longTermSendTasks.id, taskId),
					eq(longTermSendTasks.userId, userId),
				),
			)
			.limit(1);
		if (!task) return null;
		return buildLongTermTaskReadModelInTransaction(tx, task.id);
	});
}

export async function listLongTermInvestmentTasks(
	params: ListLongTermInvestmentTasksParams,
): Promise<LongTermTaskReadModel[]> {
	const userId = validateLongTermCanonicalUuid(params.userId, "userId");
	const midasAccountId =
		params.midasAccountId === undefined
			? undefined
			: validateLongTermCanonicalUuid(params.midasAccountId, "midasAccountId");
	const status = validateLongTermTaskStatusFilter(params.status);

	return runLongTermReadTransaction(params.db, async (tx) => {
		const conditions = [eq(longTermSendTasks.userId, userId)];
		if (midasAccountId !== undefined) {
			conditions.push(eq(longTermSendTasks.midasAccountId, midasAccountId));
		}

		const tasks = await tx
			.select({ id: longTermSendTasks.id })
			.from(longTermSendTasks)
			.where(and(...conditions))
			.orderBy(desc(longTermSendTasks.createdAt), asc(longTermSendTasks.id));

		const results: LongTermTaskReadModel[] = [];
		for (const t of tasks) {
			const readModel = await buildLongTermTaskReadModelInTransaction(tx, t.id);
			if (!readModel) continue;
			if (status !== undefined && readModel.status !== status) continue;
			results.push(readModel);
		}
		return results;
	});
}

export type { LongTermTaskOperation, LongTermTaskStatus };

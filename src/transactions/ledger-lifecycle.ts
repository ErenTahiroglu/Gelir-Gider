import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { journalEntries } from "../db/schema/ledger";
import { transactionLedgerBindings } from "../db/schema/transaction-ledger";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../db/schema/transactions";
import { LedgerError } from "../ledger/errors";
import {
	type JournalLineInput,
	type PostJournalEntryResult,
	postJournalEntryInTransaction,
} from "../ledger/posting";
import {
	type ReverseJournalEntryResult,
	reverseJournalEntryInTransaction,
} from "../ledger/reversal";
import { CanonicalTransactionError } from "./errors";
import {
	type CanonicalTransactionOperationResult,
	createCanonicalTransactionInTransaction,
	reviseCanonicalTransactionInTransaction,
	type TransactionSourceInput,
	voidCanonicalTransactionInTransaction,
} from "./service";

export interface CreateCanonicalTransactionWithLedgerParams {
	db: Database;
	userId: string;
	kind: string;
	idempotencyKey: string;
	occurredAt: Date;
	payload: Record<string, unknown>;
	source: TransactionSourceInput;
	ledger: {
		memo?: string | null | undefined;
		lines: JournalLineInput[];
	};
}

export interface ReviseCanonicalTransactionWithLedgerParams {
	db: Database;
	userId: string;
	transactionId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	occurredAt: Date;
	payload: Record<string, unknown>;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	source: TransactionSourceInput;
	ledger: {
		memo?: string | null | undefined;
		lines: JournalLineInput[];
	};
}

export interface VoidCanonicalTransactionWithLedgerParams {
	db: Database;
	userId: string;
	transactionId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	source: TransactionSourceInput;
}

export interface BoundCanonicalTransactionResult
	extends CanonicalTransactionOperationResult {
	ledger: {
		appliedJournalEntryId: string | null;
		reversalJournalEntryId: string | null;
	};
}

export interface CanonicalTransactionLedgerBindingItem {
	bindingId: string;
	transactionId: string;
	revisionId: string;
	previousBindingId: string | null;
	appliedJournalEntryId: string | null;
	reversalJournalEntryId: string | null;
	createdAt: Date;
}

/**
 * Atomically creates a canonical transaction and posts its double-entry ledger effect in ONE PostgreSQL transaction.
 */
export async function createCanonicalTransactionWithLedger({
	db,
	userId,
	kind,
	idempotencyKey,
	occurredAt,
	payload,
	source,
	ledger,
}: CreateCanonicalTransactionWithLedgerParams): Promise<BoundCanonicalTransactionResult> {
	if (!ledger || !Array.isArray(ledger.lines)) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Ledger specification with lines array is required",
		);
	}

	return await db.transaction(async (tx) => {
		// 1. Create canonical transaction revision in transaction
		const canonicalRes = await createCanonicalTransactionInTransaction({
			tx,
			userId,
			kind,
			idempotencyKey,
			occurredAt,
			payload,
			source,
		});

		// 2. Handle Idempotent Replay
		if (canonicalRes.idempotentReplay) {
			const [existingBinding] = await tx
				.select({
					id: transactionLedgerBindings.id,
					appliedJournalEntryId:
						transactionLedgerBindings.appliedJournalEntryId,
					reversalJournalEntryId:
						transactionLedgerBindings.reversalJournalEntryId,
				})
				.from(transactionLedgerBindings)
				.where(
					eq(transactionLedgerBindings.revisionId, canonicalRes.revisionId),
				)
				.limit(1);

			if (!existingBinding?.appliedJournalEntryId) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Canonical creation replayed but ledger binding or applied journal is missing",
				);
			}

			let postRes: PostJournalEntryResult;
			try {
				postRes = await postJournalEntryInTransaction({
					tx,
					userId,
					idempotencyKey: `txrev:${canonicalRes.revisionId}:apply`,
					occurredAt,
					memo: ledger.memo ?? undefined,
					source: {
						type: "CANONICAL_REVISION",
						ref: canonicalRes.revisionId,
					},
					lines: ledger.lines,
				});
			} catch (err) {
				if (
					err instanceof LedgerError &&
					err.code === "LEDGER_IDEMPOTENCY_CONFLICT"
				) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_EFFECT_CONFLICT",
						"Canonical transaction creation replayed with changed ledger lines",
					);
				}
				if (err instanceof LedgerError) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_EFFECT_INVALID",
						err.message,
					);
				}
				throw err;
			}

			if (
				!postRes.idempotentReplay ||
				postRes.entryId !== existingBinding.appliedJournalEntryId
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Ledger posting replay returned mismatched journal entry",
				);
			}

			return {
				transactionId: canonicalRes.transactionId,
				revisionId: canonicalRes.revisionId,
				revisionNo: canonicalRes.revisionNo,
				operation: "CREATE",
				idempotentReplay: true,
				ledger: {
					appliedJournalEntryId: existingBinding.appliedJournalEntryId,
					reversalJournalEntryId: null,
				},
			};
		}

		// 3. Fresh Creation: Post ledger entry and insert binding
		let postRes: PostJournalEntryResult;
		try {
			postRes = await postJournalEntryInTransaction({
				tx,
				userId,
				idempotencyKey: `txrev:${canonicalRes.revisionId}:apply`,
				occurredAt,
				memo: ledger.memo ?? undefined,
				source: {
					type: "CANONICAL_REVISION",
					ref: canonicalRes.revisionId,
				},
				lines: ledger.lines,
			});
		} catch (err) {
			if (
				err instanceof LedgerError &&
				err.code === "LEDGER_IDEMPOTENCY_CONFLICT"
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_EFFECT_CONFLICT",
					err.message,
				);
			}
			if (err instanceof LedgerError) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_EFFECT_INVALID",
					err.message,
				);
			}
			throw err;
		}

		const [binding] = await tx
			.insert(transactionLedgerBindings)
			.values({
				userId,
				transactionId: canonicalRes.transactionId,
				revisionId: canonicalRes.revisionId,
				previousBindingId: null,
				appliedJournalEntryId: postRes.entryId,
				reversalJournalEntryId: null,
			})
			.returning();

		if (!binding) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"Failed to insert transaction ledger binding for CREATE",
			);
		}

		return {
			transactionId: canonicalRes.transactionId,
			revisionId: canonicalRes.revisionId,
			revisionNo: canonicalRes.revisionNo,
			operation: "CREATE",
			idempotentReplay: false,
			ledger: {
				appliedJournalEntryId: postRes.entryId,
				reversalJournalEntryId: null,
			},
		};
	});
}

/**
 * Atomically updates a canonical transaction: reverses previous active journal and posts new journal in ONE transaction.
 */
export async function reviseCanonicalTransactionWithLedger({
	db,
	userId,
	transactionId,
	expectedRevisionNo,
	idempotencyKey,
	occurredAt,
	payload,
	reasonCode,
	reasonNote,
	source,
	ledger,
}: ReviseCanonicalTransactionWithLedgerParams): Promise<BoundCanonicalTransactionResult> {
	if (!ledger || !Array.isArray(ledger.lines)) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Ledger specification with lines array is required",
		);
	}

	return await db.transaction(async (tx) => {
		// 1. Revise canonical transaction in transaction
		const canonicalRes = await reviseCanonicalTransactionInTransaction({
			tx,
			userId,
			transactionId,
			expectedRevisionNo,
			idempotencyKey,
			occurredAt,
			payload,
			reasonCode,
			reasonNote,
			source,
		});

		// 2. Handle Idempotent Replay
		if (canonicalRes.idempotentReplay) {
			const [existingBinding] = await tx
				.select({
					id: transactionLedgerBindings.id,
					appliedJournalEntryId:
						transactionLedgerBindings.appliedJournalEntryId,
					reversalJournalEntryId:
						transactionLedgerBindings.reversalJournalEntryId,
				})
				.from(transactionLedgerBindings)
				.where(
					eq(transactionLedgerBindings.revisionId, canonicalRes.revisionId),
				)
				.limit(1);

			if (
				!existingBinding?.appliedJournalEntryId ||
				!existingBinding.reversalJournalEntryId
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Canonical update revision replayed but matching ledger binding is missing or incomplete",
				);
			}

			// Validate reversal replay
			const [currentRev] = await tx
				.select({
					previousRevisionId: transactionRevisions.previousRevisionId,
				})
				.from(transactionRevisions)
				.where(eq(transactionRevisions.id, canonicalRes.revisionId))
				.limit(1);

			const [prevBinding] = currentRev?.previousRevisionId
				? await tx
						.select({
							appliedJournalEntryId:
								transactionLedgerBindings.appliedJournalEntryId,
						})
						.from(transactionLedgerBindings)
						.where(
							eq(
								transactionLedgerBindings.revisionId,
								currentRev.previousRevisionId,
							),
						)
						.limit(1)
				: [];

			if (!prevBinding?.appliedJournalEntryId) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Previous revision ledger binding is missing",
				);
			}

			const [prevJournal] = await tx
				.select({ occurredAt: journalEntries.occurredAt })
				.from(journalEntries)
				.where(eq(journalEntries.id, prevBinding.appliedJournalEntryId))
				.limit(1);

			if (!prevJournal) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Previous applied journal is missing",
				);
			}

			try {
				const revReplay = await reverseJournalEntryInTransaction({
					tx,
					userId,
					originalEntryId: prevBinding.appliedJournalEntryId,
					idempotencyKey: `txrev:${canonicalRes.revisionId}:reverse`,
					occurredAt: prevJournal.occurredAt,
				});

				if (
					!revReplay.idempotentReplay ||
					revReplay.entryId !== existingBinding.reversalJournalEntryId
				) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_INCOMPLETE_STATE",
						"Reversal replay mismatch with existing binding",
					);
				}
			} catch (err) {
				if (err instanceof CanonicalTransactionError) throw err;
				if (
					err instanceof LedgerError &&
					err.code === "LEDGER_IDEMPOTENCY_CONFLICT"
				) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_EFFECT_CONFLICT",
						"Reversal idempotency conflict",
					);
				}
				if (err instanceof LedgerError) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_EFFECT_INVALID",
						err.message,
					);
				}
				throw err;
			}

			// Validate apply replay
			try {
				const applyReplay = await postJournalEntryInTransaction({
					tx,
					userId,
					idempotencyKey: `txrev:${canonicalRes.revisionId}:apply`,
					occurredAt,
					memo: ledger.memo ?? undefined,
					source: {
						type: "CANONICAL_REVISION",
						ref: canonicalRes.revisionId,
					},
					lines: ledger.lines,
				});

				if (
					!applyReplay.idempotentReplay ||
					applyReplay.entryId !== existingBinding.appliedJournalEntryId
				) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_INCOMPLETE_STATE",
						"Apply replay mismatch with existing binding",
					);
				}
			} catch (err) {
				if (err instanceof CanonicalTransactionError) throw err;
				if (
					err instanceof LedgerError &&
					err.code === "LEDGER_IDEMPOTENCY_CONFLICT"
				) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_EFFECT_CONFLICT",
						"Canonical update replayed with changed ledger lines",
					);
				}
				if (err instanceof LedgerError) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_EFFECT_INVALID",
						err.message,
					);
				}
				throw err;
			}

			return {
				transactionId: canonicalRes.transactionId,
				revisionId: canonicalRes.revisionId,
				revisionNo: canonicalRes.revisionNo,
				operation: "UPDATE",
				idempotentReplay: true,
				ledger: {
					appliedJournalEntryId: existingBinding.appliedJournalEntryId,
					reversalJournalEntryId: existingBinding.reversalJournalEntryId,
				},
			};
		}

		// 3. Fresh Update:
		const [currentRev] = await tx
			.select({
				previousRevisionId: transactionRevisions.previousRevisionId,
			})
			.from(transactionRevisions)
			.where(eq(transactionRevisions.id, canonicalRes.revisionId))
			.limit(1);

		if (!currentRev?.previousRevisionId) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"UPDATE revision missing previous revision reference",
			);
		}

		const [prevBinding] = await tx
			.select({
				id: transactionLedgerBindings.id,
				appliedJournalEntryId: transactionLedgerBindings.appliedJournalEntryId,
			})
			.from(transactionLedgerBindings)
			.where(
				eq(transactionLedgerBindings.revisionId, currentRev.previousRevisionId),
			)
			.limit(1);

		if (!prevBinding?.appliedJournalEntryId) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"Previous revision has no active applied journal entry to reverse",
			);
		}

		const [prevJournal] = await tx
			.select({ occurredAt: journalEntries.occurredAt })
			.from(journalEntries)
			.where(eq(journalEntries.id, prevBinding.appliedJournalEntryId))
			.limit(1);

		if (!prevJournal) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"Previous applied journal entry could not be found",
			);
		}

		// Reverse previous applied journal at its original economic date
		let revRes: ReverseJournalEntryResult;
		try {
			revRes = await reverseJournalEntryInTransaction({
				tx,
				userId,
				originalEntryId: prevBinding.appliedJournalEntryId,
				idempotencyKey: `txrev:${canonicalRes.revisionId}:reverse`,
				occurredAt: prevJournal.occurredAt,
				memo: null,
			});
		} catch (err) {
			if (
				err instanceof LedgerError &&
				err.code === "LEDGER_IDEMPOTENCY_CONFLICT"
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_EFFECT_CONFLICT",
					err.message,
				);
			}
			if (err instanceof LedgerError) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_EFFECT_INVALID",
					err.message,
				);
			}
			throw err;
		}

		// Post new journal entry
		let postRes: PostJournalEntryResult;
		try {
			postRes = await postJournalEntryInTransaction({
				tx,
				userId,
				idempotencyKey: `txrev:${canonicalRes.revisionId}:apply`,
				occurredAt,
				memo: ledger.memo ?? undefined,
				source: {
					type: "CANONICAL_REVISION",
					ref: canonicalRes.revisionId,
				},
				lines: ledger.lines,
			});
		} catch (err) {
			if (
				err instanceof LedgerError &&
				err.code === "LEDGER_IDEMPOTENCY_CONFLICT"
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_EFFECT_CONFLICT",
					err.message,
				);
			}
			if (err instanceof LedgerError) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_EFFECT_INVALID",
					err.message,
				);
			}
			throw err;
		}

		const [binding] = await tx
			.insert(transactionLedgerBindings)
			.values({
				userId,
				transactionId: canonicalRes.transactionId,
				revisionId: canonicalRes.revisionId,
				previousBindingId: prevBinding.id,
				appliedJournalEntryId: postRes.entryId,
				reversalJournalEntryId: revRes.entryId,
			})
			.returning();

		if (!binding) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"Failed to insert transaction ledger binding for UPDATE",
			);
		}

		return {
			transactionId: canonicalRes.transactionId,
			revisionId: canonicalRes.revisionId,
			revisionNo: canonicalRes.revisionNo,
			operation: "UPDATE",
			idempotentReplay: false,
			ledger: {
				appliedJournalEntryId: postRes.entryId,
				reversalJournalEntryId: revRes.entryId,
			},
		};
	});
}

/**
 * Atomically voids a canonical transaction and reverses its active journal in ONE transaction.
 */
export async function voidCanonicalTransactionWithLedger({
	db,
	userId,
	transactionId,
	expectedRevisionNo,
	idempotencyKey,
	reasonCode,
	reasonNote,
	source,
}: VoidCanonicalTransactionWithLedgerParams): Promise<BoundCanonicalTransactionResult> {
	return await db.transaction(async (tx) => {
		// 1. Void canonical transaction in transaction
		const canonicalRes = await voidCanonicalTransactionInTransaction({
			tx,
			userId,
			transactionId,
			expectedRevisionNo,
			idempotencyKey,
			reasonCode,
			reasonNote,
			source,
		});

		// 2. Handle Idempotent Replay
		if (canonicalRes.idempotentReplay) {
			const [existingBinding] = await tx
				.select({
					reversalJournalEntryId:
						transactionLedgerBindings.reversalJournalEntryId,
					appliedJournalEntryId:
						transactionLedgerBindings.appliedJournalEntryId,
				})
				.from(transactionLedgerBindings)
				.where(
					eq(transactionLedgerBindings.revisionId, canonicalRes.revisionId),
				)
				.limit(1);

			if (
				!existingBinding?.reversalJournalEntryId ||
				existingBinding.appliedJournalEntryId !== null
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Canonical void revision replayed but matching ledger binding is missing or malformed",
				);
			}

			// Load current VOID revision's previousRevisionId
			const [currentRev] = await tx
				.select({
					previousRevisionId: transactionRevisions.previousRevisionId,
				})
				.from(transactionRevisions)
				.where(eq(transactionRevisions.id, canonicalRes.revisionId))
				.limit(1);

			if (!currentRev?.previousRevisionId) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"VOID revision missing previous revision reference on replay",
				);
			}

			// Resolve previous revision binding
			const [prevBinding] = await tx
				.select({
					appliedJournalEntryId:
						transactionLedgerBindings.appliedJournalEntryId,
				})
				.from(transactionLedgerBindings)
				.where(
					eq(
						transactionLedgerBindings.revisionId,
						currentRev.previousRevisionId,
					),
				)
				.limit(1);

			if (!prevBinding?.appliedJournalEntryId) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Previous revision has no active applied journal entry on replay",
				);
			}

			// Load previous applied journal's occurred_at
			const [prevJournal] = await tx
				.select({ occurredAt: journalEntries.occurredAt })
				.from(journalEntries)
				.where(eq(journalEntries.id, prevBinding.appliedJournalEntryId))
				.limit(1);

			if (!prevJournal) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Previous applied journal entry could not be found on replay",
				);
			}

			// Verify deterministic reversal replay
			let revRes: ReverseJournalEntryResult;
			try {
				revRes = await reverseJournalEntryInTransaction({
					tx,
					userId,
					originalEntryId: prevBinding.appliedJournalEntryId,
					idempotencyKey: `txrev:${canonicalRes.revisionId}:reverse`,
					occurredAt: prevJournal.occurredAt,
					memo: null,
				});
			} catch (err) {
				if (err instanceof CanonicalTransactionError) throw err;
				if (
					err instanceof LedgerError &&
					err.code === "LEDGER_IDEMPOTENCY_CONFLICT"
				) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_EFFECT_CONFLICT",
						err.message,
					);
				}
				if (err instanceof LedgerError) {
					throw new CanonicalTransactionError(
						"TRANSACTION_LEDGER_EFFECT_INVALID",
						err.message,
					);
				}
				throw err;
			}

			if (
				!revRes.idempotentReplay ||
				revRes.entryId !== existingBinding.reversalJournalEntryId
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_INCOMPLETE_STATE",
					"Reversal replay mismatch with existing binding",
				);
			}

			return {
				transactionId: canonicalRes.transactionId,
				revisionId: canonicalRes.revisionId,
				revisionNo: canonicalRes.revisionNo,
				operation: "VOID",
				idempotentReplay: true,
				ledger: {
					appliedJournalEntryId: null,
					reversalJournalEntryId: existingBinding.reversalJournalEntryId,
				},
			};
		}

		// 3. Fresh Void: Reverse previous active journal
		const [currentRev] = await tx
			.select({
				previousRevisionId: transactionRevisions.previousRevisionId,
			})
			.from(transactionRevisions)
			.where(eq(transactionRevisions.id, canonicalRes.revisionId))
			.limit(1);

		if (!currentRev?.previousRevisionId) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"VOID revision missing previous revision reference",
			);
		}

		const [prevBinding] = await tx
			.select({
				id: transactionLedgerBindings.id,
				appliedJournalEntryId: transactionLedgerBindings.appliedJournalEntryId,
			})
			.from(transactionLedgerBindings)
			.where(
				eq(transactionLedgerBindings.revisionId, currentRev.previousRevisionId),
			)
			.limit(1);

		if (!prevBinding?.appliedJournalEntryId) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"Previous revision has no active applied journal entry to reverse for VOID",
			);
		}

		const [prevJournal] = await tx
			.select({ occurredAt: journalEntries.occurredAt })
			.from(journalEntries)
			.where(eq(journalEntries.id, prevBinding.appliedJournalEntryId))
			.limit(1);

		if (!prevJournal) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"Previous applied journal entry could not be found",
			);
		}

		let revRes: ReverseJournalEntryResult;
		try {
			revRes = await reverseJournalEntryInTransaction({
				tx,
				userId,
				originalEntryId: prevBinding.appliedJournalEntryId,
				idempotencyKey: `txrev:${canonicalRes.revisionId}:reverse`,
				occurredAt: prevJournal.occurredAt,
				memo: null,
			});
		} catch (err) {
			if (
				err instanceof LedgerError &&
				err.code === "LEDGER_IDEMPOTENCY_CONFLICT"
			) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_EFFECT_CONFLICT",
					err.message,
				);
			}
			if (err instanceof LedgerError) {
				throw new CanonicalTransactionError(
					"TRANSACTION_LEDGER_EFFECT_INVALID",
					err.message,
				);
			}
			throw err;
		}

		const [insertedBinding] = await tx
			.insert(transactionLedgerBindings)
			.values({
				userId,
				transactionId: canonicalRes.transactionId,
				revisionId: canonicalRes.revisionId,
				previousBindingId: prevBinding.id,
				appliedJournalEntryId: null,
				reversalJournalEntryId: revRes.entryId,
			})
			.returning();

		if (!insertedBinding) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				"Failed to insert transaction ledger binding for VOID",
			);
		}

		return {
			transactionId: canonicalRes.transactionId,
			revisionId: canonicalRes.revisionId,
			revisionNo: canonicalRes.revisionNo,
			operation: "VOID",
			idempotentReplay: false,
			ledger: {
				appliedJournalEntryId: null,
				reversalJournalEntryId: insertedBinding.reversalJournalEntryId,
			},
		};
	});
}

/**
 * Retrieves the ledger binding for a specific transaction revision or the latest revision.
 */
export async function getCanonicalTransactionLedgerBinding({
	db,
	userId,
	transactionId,
	revisionId,
}: {
	db: Database;
	userId: string;
	transactionId: string;
	revisionId?: string | undefined;
}): Promise<CanonicalTransactionLedgerBindingItem> {
	if (!userId || userId.trim() === "") {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"User ID is required",
		);
	}

	const trimmedTxId = transactionId?.trim();
	if (!trimmedTxId) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Transaction ID is required",
		);
	}

	// Verify transaction ownership
	const [txRow] = await db
		.select({ id: canonicalTransactions.id })
		.from(canonicalTransactions)
		.where(
			and(
				eq(canonicalTransactions.id, trimmedTxId),
				eq(canonicalTransactions.userId, userId),
			),
		)
		.limit(1);

	if (!txRow) {
		throw new CanonicalTransactionError(
			"TRANSACTION_NOT_FOUND",
			`Canonical transaction "${trimmedTxId}" not found for this user`,
		);
	}

	let targetRevisionId = revisionId?.trim();

	if (!targetRevisionId) {
		const [latestRev] = await db
			.select({ id: transactionRevisions.id })
			.from(transactionRevisions)
			.where(
				and(
					eq(transactionRevisions.transactionId, trimmedTxId),
					eq(transactionRevisions.userId, userId),
				),
			)
			.orderBy(desc(transactionRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			throw new CanonicalTransactionError(
				"TRANSACTION_INVALID_STATE",
				"Transaction has no revisions",
			);
		}
		targetRevisionId = latestRev.id;
	} else {
		// Defense-in-depth: Validate that explicit revisionId belongs to this user and transactionId
		const [revRow] = await db
			.select({ id: transactionRevisions.id })
			.from(transactionRevisions)
			.where(
				and(
					eq(transactionRevisions.id, targetRevisionId),
					eq(transactionRevisions.transactionId, trimmedTxId),
					eq(transactionRevisions.userId, userId),
				),
			)
			.limit(1);

		if (!revRow) {
			throw new CanonicalTransactionError(
				"TRANSACTION_LEDGER_INCOMPLETE_STATE",
				`Revision "${targetRevisionId}" does not belong to transaction "${trimmedTxId}"`,
			);
		}
	}

	const [binding] = await db
		.select({
			bindingId: transactionLedgerBindings.id,
			transactionId: transactionLedgerBindings.transactionId,
			revisionId: transactionLedgerBindings.revisionId,
			previousBindingId: transactionLedgerBindings.previousBindingId,
			appliedJournalEntryId: transactionLedgerBindings.appliedJournalEntryId,
			reversalJournalEntryId: transactionLedgerBindings.reversalJournalEntryId,
			createdAt: transactionLedgerBindings.createdAt,
		})
		.from(transactionLedgerBindings)
		.where(
			and(
				eq(transactionLedgerBindings.userId, userId),
				eq(transactionLedgerBindings.transactionId, trimmedTxId),
				eq(transactionLedgerBindings.revisionId, targetRevisionId),
			),
		)
		.limit(1);

	if (!binding) {
		throw new CanonicalTransactionError(
			"TRANSACTION_LEDGER_INCOMPLETE_STATE",
			`No ledger binding found for revision "${targetRevisionId}"`,
		);
	}

	return {
		bindingId: binding.bindingId,
		transactionId: binding.transactionId,
		revisionId: binding.revisionId,
		previousBindingId: binding.previousBindingId,
		appliedJournalEntryId: binding.appliedJournalEntryId,
		reversalJournalEntryId: binding.reversalJournalEntryId,
		createdAt: binding.createdAt,
	};
}

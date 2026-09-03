import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import { journalEntries, journalLines } from "../db/schema/ledger";
import { LedgerError } from "./errors";
import { formatCentsToMoney, parseMoneyString } from "./money";

export interface ReverseJournalEntryParams {
	db: Database;
	userId: string;
	originalEntryId: string;
	idempotencyKey: string;
	occurredAt: Date;
	memo?: string | null | undefined;
}

export interface ReverseJournalEntryInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	originalEntryId: string;
	idempotencyKey: string;
	occurredAt: Date;
	memo?: string | null | undefined;
}

export interface ReverseJournalEntryResult {
	entryId: string;
	reversalOfEntryId: string;
	idempotentReplay: boolean;
	currency: string;
	debitTotal: string;
	creditTotal: string;
	lineCount: number;
}

interface ReversedLineData {
	lineNo: number;
	accountId: string;
	side: "DEBIT" | "CREDIT";
	amountNormalized: string;
	cents: bigint;
	debitStr: string;
	creditStr: string;
	memo: string | null;
}

function validateReversalInput({
	userId,
	originalEntryId,
	idempotencyKey,
	occurredAt,
	memo,
}: {
	userId: string;
	originalEntryId: string;
	idempotencyKey: string;
	occurredAt: Date;
	memo?: string | null | undefined;
}): {
	trimmedOriginalEntryId: string;
	trimmedIdempotencyKey: string;
	normalizedMemo: string | null;
} {
	if (!userId || userId.trim() === "") {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User ID is required");
	}

	const trimmedOriginalEntryId = originalEntryId?.trim();
	if (!trimmedOriginalEntryId) {
		throw new LedgerError(
			"LEDGER_ENTRY_NOT_FOUND",
			"Original entry ID is required",
		);
	}

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (
		!trimmedIdempotencyKey ||
		trimmedIdempotencyKey.length < 1 ||
		trimmedIdempotencyKey.length > 128
	) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"Idempotency key must be between 1 and 128 characters",
		);
	}

	if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"Valid occurredAt Date is required for reversal",
		);
	}

	const normalizedMemo =
		memo !== undefined && memo !== null ? memo.trim() : null;
	if (normalizedMemo !== null && normalizedMemo.length > 500) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"Memo must not exceed 500 characters",
		);
	}

	return {
		trimmedOriginalEntryId,
		trimmedIdempotencyKey,
		normalizedMemo,
	};
}

/**
 * Computes a deterministic SHA-256 reversal fingerprint (64 lowercase hex)
 * using versioned structured array serialization.
 */
export async function calculateReversalFingerprint(params: {
	userId: string;
	originalEntryId: string;
	occurredAt: Date;
	currency: string;
	memo: string | null;
	lines: {
		accountId: string;
		side: "DEBIT" | "CREDIT";
		amountNormalized: string;
		memo: string | null;
	}[];
}): Promise<string> {
	const canonicalPayload = [
		"ledger-reversal-v1",
		params.userId,
		params.originalEntryId,
		params.occurredAt.toISOString(),
		params.currency,
		params.memo,
		params.lines.map((line) => [
			line.accountId,
			line.side,
			line.amountNormalized,
			line.memo,
		]),
	];

	const serialized = JSON.stringify(canonicalPayload);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Internal transaction-scoped helper for reversing a journal entry within an existing PostgreSQL transaction.
 * Does NOT initiate a new db.transaction().
 */
export async function reverseJournalEntryInTransaction({
	tx,
	userId,
	originalEntryId,
	idempotencyKey,
	occurredAt,
	memo,
}: ReverseJournalEntryInTransactionParams): Promise<ReverseJournalEntryResult> {
	const { trimmedOriginalEntryId, trimmedIdempotencyKey, normalizedMemo } =
		validateReversalInput({
			userId,
			originalEntryId,
			idempotencyKey,
			occurredAt,
			memo,
		});

	// 1. Early Idempotency Fast Path
	const [existingEarly] = await tx
		.select({
			id: journalEntries.id,
			status: journalEntries.status,
			currency: journalEntries.currency,
			postingFingerprint: journalEntries.postingFingerprint,
			reversalOfEntryId: journalEntries.reversalOfEntryId,
		})
		.from(journalEntries)
		.where(
			and(
				eq(journalEntries.userId, userId),
				eq(journalEntries.idempotencyKey, trimmedIdempotencyKey),
			),
		)
		.limit(1);

	if (existingEarly) {
		if (existingEarly.status !== "POSTED") {
			throw new LedgerError(
				"LEDGER_INCOMPLETE_STATE",
				"Concurrent unfinalized draft exists for this idempotency key",
			);
		}

		if (existingEarly.reversalOfEntryId !== trimmedOriginalEntryId) {
			throw new LedgerError(
				"LEDGER_IDEMPOTENCY_CONFLICT",
				"Idempotency key was used for a different entry or operation",
			);
		}

		// Load original lines to compute candidate fingerprint
		const originalLines = await tx
			.select({
				lineNo: journalLines.lineNo,
				accountId: journalLines.accountId,
				debit: journalLines.debit,
				credit: journalLines.credit,
				memo: journalLines.memo,
			})
			.from(journalLines)
			.where(eq(journalLines.journalEntryId, trimmedOriginalEntryId))
			.orderBy(journalLines.lineNo);

		const reversedLinesData = originalLines.map((l) => {
			const debitParsed = parseMoneyString(l.debit);
			const creditParsed = parseMoneyString(l.credit);
			const isDebit = creditParsed.cents > 0n;
			const side: "DEBIT" | "CREDIT" = isDebit ? "DEBIT" : "CREDIT";
			const amountNormalized = isDebit
				? creditParsed.normalized
				: debitParsed.normalized;
			const cents = isDebit ? creditParsed.cents : debitParsed.cents;

			return {
				accountId: l.accountId,
				side,
				amountNormalized,
				cents,
				memo: l.memo,
			};
		});

		const candidateFingerprint = await calculateReversalFingerprint({
			userId,
			originalEntryId: trimmedOriginalEntryId,
			occurredAt,
			currency: existingEarly.currency,
			memo: normalizedMemo,
			lines: reversedLinesData,
		});

		if (existingEarly.postingFingerprint !== candidateFingerprint) {
			throw new LedgerError(
				"LEDGER_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different reversal payload",
			);
		}

		const debitSum = reversedLinesData
			.filter((l) => l.side === "DEBIT")
			.reduce((sum, l) => sum + l.cents, 0n);
		const creditSum = reversedLinesData
			.filter((l) => l.side === "CREDIT")
			.reduce((sum, l) => sum + l.cents, 0n);

		return {
			entryId: existingEarly.id,
			reversalOfEntryId: trimmedOriginalEntryId,
			idempotentReplay: true,
			currency: existingEarly.currency,
			debitTotal: formatCentsToMoney(debitSum),
			creditTotal: formatCentsToMoney(creditSum),
			lineCount: reversedLinesData.length,
		};
	}

	// 2. Lock Original Entry (FOR UPDATE)
	const [originalEntry] = await tx
		.select({
			id: journalEntries.id,
			userId: journalEntries.userId,
			currency: journalEntries.currency,
			status: journalEntries.status,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, trimmedOriginalEntryId))
		.for("update")
		.limit(1);

	if (!originalEntry || originalEntry.userId !== userId) {
		throw new LedgerError(
			"LEDGER_ENTRY_NOT_FOUND",
			`Original journal entry "${trimmedOriginalEntryId}" not found`,
		);
	}

	if (originalEntry.status !== "POSTED") {
		throw new LedgerError(
			"LEDGER_INVALID_REVERSAL",
			`Cannot reverse journal entry in "${originalEntry.status}" status. Entry must be POSTED.`,
		);
	}

	// 3. Check if already reversed
	const [existingReversal] = await tx
		.select({
			id: journalEntries.id,
		})
		.from(journalEntries)
		.where(eq(journalEntries.reversalOfEntryId, trimmedOriginalEntryId))
		.limit(1);

	if (existingReversal) {
		throw new LedgerError(
			"LEDGER_ALREADY_REVERSED",
			`Journal entry "${trimmedOriginalEntryId}" has already been reversed by entry "${existingReversal.id}"`,
		);
	}

	// 4. Load original lines in deterministic order
	const originalLines = await tx
		.select({
			lineNo: journalLines.lineNo,
			accountId: journalLines.accountId,
			debit: journalLines.debit,
			credit: journalLines.credit,
			memo: journalLines.memo,
		})
		.from(journalLines)
		.where(eq(journalLines.journalEntryId, trimmedOriginalEntryId))
		.orderBy(journalLines.lineNo);

	if (originalLines.length < 2) {
		throw new LedgerError(
			"LEDGER_INVALID_REVERSAL",
			"Original journal entry has invalid line count (< 2)",
		);
	}

	// 5. Invert original lines (exact swap of debit and credit)
	const reversedLines: ReversedLineData[] = [];
	let debitCentsSum = 0n;
	let creditCentsSum = 0n;

	for (const origLine of originalLines) {
		const origDebit = parseMoneyString(origLine.debit);
		const origCredit = parseMoneyString(origLine.credit);

		if (origDebit.cents > 0n && origCredit.cents === 0n) {
			// Original was DEBIT -> Reversal is CREDIT
			reversedLines.push({
				lineNo: origLine.lineNo,
				accountId: origLine.accountId,
				side: "CREDIT",
				amountNormalized: origDebit.normalized,
				cents: origDebit.cents,
				debitStr: "0.00",
				creditStr: origDebit.normalized,
				memo: origLine.memo,
			});
			creditCentsSum += origDebit.cents;
		} else if (origCredit.cents > 0n && origDebit.cents === 0n) {
			// Original was CREDIT -> Reversal is DEBIT
			reversedLines.push({
				lineNo: origLine.lineNo,
				accountId: origLine.accountId,
				side: "DEBIT",
				amountNormalized: origCredit.normalized,
				cents: origCredit.cents,
				debitStr: origCredit.normalized,
				creditStr: "0.00",
				memo: origLine.memo,
			});
			debitCentsSum += origCredit.cents;
		} else {
			throw new LedgerError(
				"LEDGER_INVALID_REVERSAL",
				`Original line ${origLine.lineNo} is not single-sided`,
			);
		}
	}

	// 6. Compute reversal fingerprint
	const fingerprint = await calculateReversalFingerprint({
		userId,
		originalEntryId: trimmedOriginalEntryId,
		occurredAt,
		currency: originalEntry.currency,
		memo: normalizedMemo,
		lines: reversedLines.map((l) => ({
			accountId: l.accountId,
			side: l.side,
			amountNormalized: l.amountNormalized,
			memo: l.memo,
		})),
	});

	// 7. Insert reversal DRAFT
	let insertedDraft: typeof journalEntries.$inferSelect | undefined;
	try {
		const [inserted] = await tx
			.insert(journalEntries)
			.values({
				userId,
				idempotencyKey: trimmedIdempotencyKey,
				postingFingerprint: fingerprint,
				currency: originalEntry.currency,
				occurredAt,
				status: "DRAFT",
				postedAt: null,
				reversalOfEntryId: trimmedOriginalEntryId,
				memo: normalizedMemo,
				sourceType: "REVERSAL",
				sourceRef: trimmedOriginalEntryId,
			})
			.onConflictDoNothing({
				target: [journalEntries.userId, journalEntries.idempotencyKey],
			})
			.returning();

		insertedDraft = inserted;
	} catch (err) {
		if (
			err instanceof Error &&
			err.message.includes("journal_entries_reversal_of_entry_idx")
		) {
			throw new LedgerError(
				"LEDGER_ALREADY_REVERSED",
				`Journal entry "${trimmedOriginalEntryId}" has already been reversed by another transaction`,
			);
		}
		throw err;
	}

	if (!insertedDraft) {
		const [existingLate] = await tx
			.select()
			.from(journalEntries)
			.where(
				and(
					eq(journalEntries.userId, userId),
					eq(journalEntries.idempotencyKey, trimmedIdempotencyKey),
				),
			)
			.limit(1);

		if (!existingLate) {
			throw new LedgerError(
				"LEDGER_INCOMPLETE_STATE",
				"Idempotency conflict detected but record could not be retrieved",
			);
		}

		if (existingLate.status !== "POSTED") {
			throw new LedgerError(
				"LEDGER_INCOMPLETE_STATE",
				"Concurrent unfinalized draft exists for this idempotency key",
			);
		}

		if (existingLate.reversalOfEntryId !== trimmedOriginalEntryId) {
			throw new LedgerError(
				"LEDGER_IDEMPOTENCY_CONFLICT",
				"Idempotency key was used for a different entry or operation",
			);
		}

		if (existingLate.postingFingerprint !== fingerprint) {
			throw new LedgerError(
				"LEDGER_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different reversal payload",
			);
		}

		return {
			entryId: existingLate.id,
			reversalOfEntryId: trimmedOriginalEntryId,
			idempotentReplay: true,
			currency: existingLate.currency,
			debitTotal: formatCentsToMoney(debitCentsSum),
			creditTotal: formatCentsToMoney(creditCentsSum),
			lineCount: reversedLines.length,
		};
	}

	// 8. Insert reversed lines
	const lineValues = reversedLines.map((l) => ({
		journalEntryId: insertedDraft.id,
		lineNo: l.lineNo,
		accountId: l.accountId,
		debit: l.debitStr,
		credit: l.creditStr,
		memo: l.memo,
	}));

	await tx.insert(journalLines).values(lineValues);

	// 9. Transition DRAFT -> POSTED (triggers DB verification of exact inverse lines)
	try {
		const [postedEntry] = await tx
			.update(journalEntries)
			.set({
				status: "POSTED",
				postedAt: new Date(),
			})
			.where(eq(journalEntries.id, insertedDraft.id))
			.returning();

		if (postedEntry?.status !== "POSTED") {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				"Failed to transition reversal entry to POSTED state",
			);
		}

		return {
			entryId: postedEntry.id,
			reversalOfEntryId: trimmedOriginalEntryId,
			idempotentReplay: false,
			currency: originalEntry.currency,
			debitTotal: formatCentsToMoney(debitCentsSum),
			creditTotal: formatCentsToMoney(creditCentsSum),
			lineCount: reversedLines.length,
		};
	} catch (err) {
		if (
			err instanceof Error &&
			err.message.includes("journal_entries_reversal_of_entry_idx")
		) {
			throw new LedgerError(
				"LEDGER_ALREADY_REVERSED",
				`Journal entry "${trimmedOriginalEntryId}" has already been reversed by another transaction`,
			);
		}
		throw err;
	}
}

/**
 * Atomically reverses a POSTED journal entry by creating an exact inverse journal entry.
 * Enforces self-FK, partial unique direct reversal constraint, and historical currency immutability.
 */
export async function reverseJournalEntry(
	params: ReverseJournalEntryParams,
): Promise<ReverseJournalEntryResult> {
	validateReversalInput(params);
	return await params.db.transaction(async (tx) => {
		return await reverseJournalEntryInTransaction({
			tx,
			userId: params.userId,
			originalEntryId: params.originalEntryId,
			idempotencyKey: params.idempotencyKey,
			occurredAt: params.occurredAt,
			memo: params.memo,
		});
	});
}

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import {
	journalEntries,
	journalLines,
	ledgerAccounts,
} from "../db/schema/ledger";
import type {
	AccountType,
	LedgerAccountRecord,
	NormalBalance,
} from "./accounts";
import { LedgerError } from "./errors";
import { formatCentsToMoney, parsePositiveMoneyString } from "./money";

export type JournalLineSide = "DEBIT" | "CREDIT";

export interface JournalLineInput {
	accountId: string;
	side: JournalLineSide;
	amount: string; // Exact decimal string
	memo?: string | undefined;
}

export interface JournalSourceInput {
	type: string;
	ref: string;
}

export interface PostJournalEntryParams {
	db: Database;
	userId: string;
	idempotencyKey: string;
	occurredAt: Date;
	memo?: string | undefined;
	source?: JournalSourceInput | undefined;
	lines: JournalLineInput[];
}

export interface PostJournalEntryInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	idempotencyKey: string;
	occurredAt: Date;
	memo?: string | undefined;
	source?: JournalSourceInput | undefined;
	lines: JournalLineInput[];
}

export interface PostJournalEntryResult {
	entryId: string;
	idempotentReplay: boolean;
	currency: string;
	debitTotal: string;
	creditTotal: string;
	lineCount: number;
}

interface NormalizedLine {
	accountId: string;
	side: JournalLineSide;
	amountNormalized: string;
	cents: bigint;
	memo: string | null;
}

function validatePostingInput({
	userId,
	idempotencyKey,
	occurredAt,
	memo,
	source,
	lines,
}: {
	userId: string;
	idempotencyKey: string;
	occurredAt: Date;
	memo?: string | undefined;
	source?: JournalSourceInput | undefined;
	lines: JournalLineInput[];
}): {
	trimmedIdempotencyKey: string;
	normalizedMemo: string | null;
	normalizedSource: JournalSourceInput | null;
	normalizedLines: NormalizedLine[];
	debitCentsSum: bigint;
	creditCentsSum: bigint;
} {
	if (!userId || userId.trim() === "") {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User ID is required");
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
			"Valid occurredAt Date is required",
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

	let normalizedSource: JournalSourceInput | null = null;
	if (source !== undefined && source !== null) {
		const type = source.type?.trim();
		const ref = source.ref?.trim();
		if (!type || !ref) {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				"Source must have non-empty type and ref if provided",
			);
		}
		if (type.length > 64 || ref.length > 128) {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				"Source type max length is 64, ref max length is 128",
			);
		}
		normalizedSource = { type, ref };
	}

	if (!Array.isArray(lines) || lines.length < 2) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"Journal entry must have at least 2 lines",
		);
	}

	if (lines.length > 100) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"Journal entry cannot exceed 100 lines",
		);
	}

	let debitCount = 0;
	let creditCount = 0;
	let debitCentsSum = 0n;
	let creditCentsSum = 0n;

	const normalizedLines: NormalizedLine[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) {
			throw new LedgerError("LEDGER_INVALID_ENTRY", `Line ${i + 1} is empty`);
		}

		if (!line.accountId || line.accountId.trim() === "") {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				`Line ${i + 1} missing accountId`,
			);
		}

		if (line.side !== "DEBIT" && line.side !== "CREDIT") {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				`Line ${i + 1} invalid side "${line.side}". Must be DEBIT or CREDIT`,
			);
		}

		let parsedAmount: { normalized: string; cents: bigint };
		try {
			parsedAmount = parsePositiveMoneyString(line.amount);
		} catch (err) {
			throw new LedgerError(
				"INVALID_MONEY",
				`Line ${i + 1} invalid amount: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (line.side === "DEBIT") {
			debitCount++;
			debitCentsSum += parsedAmount.cents;
		} else {
			creditCount++;
			creditCentsSum += parsedAmount.cents;
		}

		const lineMemo =
			line.memo !== undefined && line.memo !== null ? line.memo.trim() : null;
		if (lineMemo !== null && lineMemo.length > 500) {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				`Line ${i + 1} memo exceeds 500 characters`,
			);
		}

		normalizedLines.push({
			accountId: line.accountId.trim(),
			side: line.side,
			amountNormalized: parsedAmount.normalized,
			cents: parsedAmount.cents,
			memo: lineMemo,
		});
	}

	if (debitCount === 0 || creditCount === 0) {
		throw new LedgerError(
			"LEDGER_UNBALANCED",
			"Journal entry must have at least one DEBIT and at least one CREDIT line",
		);
	}

	if (debitCentsSum !== creditCentsSum || debitCentsSum === 0n) {
		throw new LedgerError(
			"LEDGER_UNBALANCED",
			`Journal entry is unbalanced: DEBIT total is ${formatCentsToMoney(debitCentsSum)}, CREDIT total is ${formatCentsToMoney(creditCentsSum)}`,
		);
	}

	return {
		trimmedIdempotencyKey,
		normalizedMemo,
		normalizedSource,
		normalizedLines,
		debitCentsSum,
		creditCentsSum,
	};
}

/**
 * Computes a deterministic SHA-256 posting fingerprint (64 lowercase hex)
 * using versioned structured canonical array serialization and standard Web Crypto API.
 */
export async function calculatePostingFingerprint(params: {
	userId: string;
	occurredAt: Date;
	currency: string;
	memo: string | null;
	source: JournalSourceInput | null;
	lines: NormalizedLine[];
}): Promise<string> {
	const canonicalPayload = [
		"ledger-posting-v1",
		params.userId,
		params.occurredAt.toISOString(),
		params.currency,
		params.memo,
		params.source
			? [params.source.type.trim(), params.source.ref.trim()]
			: null,
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
 * Internal transaction-scoped helper for posting a journal entry within an existing PostgreSQL transaction.
 * Does NOT initiate a new db.transaction().
 */
export async function postJournalEntryInTransaction({
	tx,
	userId,
	idempotencyKey,
	occurredAt,
	memo,
	source,
	lines,
}: PostJournalEntryInTransactionParams): Promise<PostJournalEntryResult> {
	const {
		trimmedIdempotencyKey,
		normalizedMemo,
		normalizedSource,
		normalizedLines,
		debitCentsSum,
		creditCentsSum,
	} = validatePostingInput({
		userId,
		idempotencyKey,
		occurredAt,
		memo,
		source,
		lines,
	});

	// 1. Historical Replay Fast Path
	const [existingEarly] = await tx
		.select({
			id: journalEntries.id,
			status: journalEntries.status,
			currency: journalEntries.currency,
			postingFingerprint: journalEntries.postingFingerprint,
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

		// Fingerprint must be computed with the historical journal currency
		const candidateFingerprint = await calculatePostingFingerprint({
			userId,
			occurredAt,
			currency: existingEarly.currency,
			memo: normalizedMemo,
			source: normalizedSource,
			lines: normalizedLines,
		});

		if (existingEarly.postingFingerprint !== candidateFingerprint) {
			throw new LedgerError(
				"LEDGER_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different entry payload",
			);
		}

		return {
			entryId: existingEarly.id,
			idempotentReplay: true,
			currency: existingEarly.currency,
			debitTotal: formatCentsToMoney(debitCentsSum),
			creditTotal: formatCentsToMoney(creditCentsSum),
			lineCount: normalizedLines.length,
		};
	}

	// 2. New Posting Path: Resolve User and Validate Current Account States
	const [user] = await tx
		.select({ id: users.id, currency: users.currency })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User does not exist");
	}

	// Resolve all unique account IDs in one single query
	const uniqueAccountIds = Array.from(
		new Set(normalizedLines.map((l) => l.accountId)),
	);

	const resolvedAccounts = await tx
		.select({
			id: ledgerAccounts.id,
			userId: ledgerAccounts.userId,
			currency: ledgerAccounts.currency,
			archivedAt: ledgerAccounts.archivedAt,
		})
		.from(ledgerAccounts)
		.where(inArray(ledgerAccounts.id, uniqueAccountIds));

	const accountMap = new Map(resolvedAccounts.map((a) => [a.id, a]));

	for (const accId of uniqueAccountIds) {
		const acc = accountMap.get(accId);
		if (!acc || acc.userId !== user.id) {
			throw new LedgerError(
				"LEDGER_ACCOUNT_NOT_FOUND",
				`Account "${accId}" not found for this user`,
			);
		}

		if (acc.archivedAt !== null) {
			throw new LedgerError(
				"LEDGER_ACCOUNT_ARCHIVED",
				`Account "${accId}" is archived and cannot receive new postings`,
			);
		}

		if (acc.currency !== user.currency) {
			throw new LedgerError(
				"LEDGER_CURRENCY_MISMATCH",
				`Account "${accId}" currency "${acc.currency}" does not match user currency "${user.currency}"`,
			);
		}
	}

	// 3. Compute Posting Fingerprint
	const fingerprint = await calculatePostingFingerprint({
		userId,
		occurredAt,
		currency: user.currency,
		memo: normalizedMemo,
		source: normalizedSource,
		lines: normalizedLines,
	});

	// 4. Insert DRAFT journal entry with race-safe ON CONFLICT DO NOTHING
	const [insertedDraft] = await tx
		.insert(journalEntries)
		.values({
			userId,
			status: "DRAFT",
			occurredAt,
			currency: user.currency,
			memo: normalizedMemo,
			sourceType: normalizedSource ? normalizedSource.type : null,
			sourceRef: normalizedSource ? normalizedSource.ref : null,
			idempotencyKey: trimmedIdempotencyKey,
			postingFingerprint: fingerprint,
		})
		.onConflictDoNothing({
			target: [journalEntries.userId, journalEntries.idempotencyKey],
		})
		.returning();

	if (!insertedDraft) {
		// Concurrent race inserted an entry for this (userId, idempotencyKey)
		const [existingLate] = await tx
			.select({
				id: journalEntries.id,
				status: journalEntries.status,
				currency: journalEntries.currency,
				postingFingerprint: journalEntries.postingFingerprint,
			})
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
				"LEDGER_INVALID_ENTRY",
				"Failed to retrieve journal entry after concurrent conflict",
			);
		}

		if (existingLate.status !== "POSTED") {
			throw new LedgerError(
				"LEDGER_INCOMPLETE_STATE",
				"Concurrent unfinalized draft exists for this idempotency key",
			);
		}

		const candidateFingerprint = await calculatePostingFingerprint({
			userId,
			occurredAt,
			currency: existingLate.currency,
			memo: normalizedMemo,
			source: normalizedSource,
			lines: normalizedLines,
		});

		if (existingLate.postingFingerprint !== candidateFingerprint) {
			throw new LedgerError(
				"LEDGER_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different entry payload",
			);
		}

		// Same idempotency key and identical fingerprint -> Idempotent Replay
		return {
			entryId: existingLate.id,
			idempotentReplay: true,
			currency: existingLate.currency,
			debitTotal: formatCentsToMoney(debitCentsSum),
			creditTotal: formatCentsToMoney(creditCentsSum),
			lineCount: normalizedLines.length,
		};
	}

	// Newly created DRAFT: insert all lines
	const lineValues = normalizedLines.map((line, idx) => ({
		journalEntryId: insertedDraft.id,
		lineNo: idx + 1,
		accountId: line.accountId,
		debit: line.side === "DEBIT" ? line.amountNormalized : "0.00",
		credit: line.side === "CREDIT" ? line.amountNormalized : "0.00",
		memo: line.memo,
	}));

	await tx.insert(journalLines).values(lineValues);

	// Transition DRAFT -> POSTED (triggers database validation invariants)
	const now = new Date();
	const [postedEntry] = await tx
		.update(journalEntries)
		.set({
			status: "POSTED",
			postedAt: now,
		})
		.where(eq(journalEntries.id, insertedDraft.id))
		.returning();

	if (postedEntry?.status !== "POSTED") {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"Failed to transition journal entry to POSTED state",
		);
	}

	return {
		entryId: postedEntry.id,
		idempotentReplay: false,
		currency: user.currency,
		debitTotal: formatCentsToMoney(debitCentsSum),
		creditTotal: formatCentsToMoney(creditCentsSum),
		lineCount: normalizedLines.length,
	};
}

/**
 * Posts a double-entry journal entry atomically.
 * Guarantees balance, account currency matching, active accounts, and race-safe idempotency.
 */
export async function postJournalEntry(
	params: PostJournalEntryParams,
): Promise<PostJournalEntryResult> {
	validatePostingInput(params);
	return await params.db.transaction(async (tx) => {
		return await postJournalEntryInTransaction({
			tx,
			userId: params.userId,
			idempotencyKey: params.idempotencyKey,
			occurredAt: params.occurredAt,
			memo: params.memo,
			source: params.source,
			lines: params.lines,
		});
	});
}

export interface LockLedgerAccountsParams {
	tx: DatabaseTransaction;
	userId: string;
	accountIds: string[];
}

/**
 * Deterministically locks the requested ledger accounts in ascending UUID order (FOR UPDATE).
 * Validates ownership, existence, and non-archived status.
 */
export async function lockLedgerAccountsInTransaction({
	tx,
	userId,
	accountIds,
}: LockLedgerAccountsParams): Promise<LedgerAccountRecord[]> {
	if (!userId || userId.trim() === "") {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User ID is required");
	}

	if (!Array.isArray(accountIds) || accountIds.length === 0) {
		return [];
	}

	const sortedUniqueIds = Array.from(
		new Set(accountIds.map((id) => id.trim().toLowerCase())),
	).sort();

	const rows = await tx
		.select()
		.from(ledgerAccounts)
		.where(
			and(
				eq(ledgerAccounts.userId, userId),
				inArray(ledgerAccounts.id, sortedUniqueIds),
			),
		)
		.orderBy(asc(ledgerAccounts.id))
		.for("update");

	if (rows.length !== sortedUniqueIds.length) {
		const foundIds = new Set(rows.map((r) => r.id.toLowerCase()));
		const missing = sortedUniqueIds.filter((id) => !foundIds.has(id));
		throw new LedgerError(
			"LEDGER_ACCOUNT_NOT_FOUND",
			`Ledger account(s) not found: ${missing.join(", ")}`,
		);
	}

	for (const row of rows) {
		if (row.archivedAt !== null) {
			throw new LedgerError(
				"LEDGER_ACCOUNT_ARCHIVED",
				`Account "${row.code}" is archived and cannot receive postings`,
			);
		}
	}

	return rows.map((r) => ({
		id: r.id,
		userId: r.userId,
		code: r.code,
		name: r.name,
		accountType: r.accountType as AccountType,
		normalBalance: r.normalBalance as NormalBalance,
		currency: r.currency,
		createdAt: r.createdAt,
		archivedAt: r.archivedAt,
	}));
}

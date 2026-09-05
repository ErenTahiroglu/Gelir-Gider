import { and, asc, desc, eq } from "drizzle-orm";
import type {
	Database,
	DatabaseOrTransaction,
	DatabaseTransaction,
} from "../db/client";
import { creditCards } from "../db/schema/credit-cards";
import { rewardAccountRevisions, rewardAccounts } from "../db/schema/rewards";
import { runRewardsReadTransaction, runRewardsTransaction } from "./boundary";
import {
	validateRewardAccountCode,
	validateRewardAccountStatusFilter,
	validateRewardCanonicalUuid,
	validateRewardExpectedRevisionNo,
	validateRewardIdempotencyKey,
	validateRewardOccurredAt,
	validateRewardOptionalText,
	validateRewardRequiredText,
} from "./calendar";
import {
	formatUnitsToDecimal,
	parseConversionRate,
	roundHalfUpToEconomicCents,
} from "./decimal";
import { RewardError } from "./errors";
import { deriveRewardPointBalanceInTransaction } from "./events";
import {
	calculateRewardAccountArchiveFingerprint,
	calculateRewardAccountCreateFingerprint,
	calculateRewardAccountUpdateFingerprint,
} from "./fingerprint";

const DEFAULT_CONVERSION_RATE = "1.000000";

export interface RewardAccountReadModel {
	rewardAccountId: string;
	code: string;
	status: "ACTIVE" | "ARCHIVED";
	displayName: string;
	provider: string;
	unitName: string;
	creditCardId: string | null;
	defaultConversionRate: string;
	balancePoints: string;
	estimatedCurrentValue: string;
	revisionNo: number;
	occurredAt: Date;
	createdAt: Date;
}

export interface CreateRewardAccountParams {
	db: Database;
	userId: string;
	code: string;
	displayName: string;
	provider: string;
	unitName: string;
	creditCardId?: string | null | undefined;
	defaultConversionRate?: string | undefined;
	note?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateRewardAccountParams {
	db: Database;
	userId: string;
	rewardAccountId: string;
	expectedRevisionNo: number;
	displayName: string;
	provider: string;
	unitName: string;
	defaultConversionRate?: string | undefined;
	note?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface ArchiveRewardAccountParams {
	db: Database;
	userId: string;
	rewardAccountId: string;
	expectedRevisionNo: number;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface GetRewardAccountParams {
	db: Database;
	userId: string;
	rewardAccountId: string;
}

export interface ListRewardAccountsParams {
	db: Database;
	userId: string;
	status?: "ACTIVE" | "ARCHIVED" | undefined;
}

// ============================================================================
// Pure, DB-independent validation helpers
// ============================================================================

/** CREATE only: an omitted rate defaults to 1.000000. */
function validateDefaultConversionRateForCreate(value: unknown): string {
	if (value === undefined) return DEFAULT_CONVERSION_RATE;
	return parseConversionRate(value, "defaultConversionRate").normalized;
}

/**
 * UPDATE only: an omitted rate must NOT silently reset to 1.000000 -- it
 * must preserve whatever the account's current rate already is. Returns
 * `undefined` when omitted so the caller can resolve the effective rate
 * against the correct historical/current revision.
 */
function validateDefaultConversionRateOverrideForUpdate(
	value: unknown,
): string | undefined {
	if (value === undefined) return undefined;
	return parseConversionRate(value, "defaultConversionRate").normalized;
}

// ============================================================================
// Read Model Construction
// ============================================================================

export async function buildRewardAccountReadModelInTransaction(
	tx: DatabaseOrTransaction,
	rewardAccountId: string,
): Promise<RewardAccountReadModel | null> {
	const [account] = await tx
		.select()
		.from(rewardAccounts)
		.where(eq(rewardAccounts.id, rewardAccountId))
		.limit(1);
	if (!account) return null;

	const [latestRev] = await tx
		.select()
		.from(rewardAccountRevisions)
		.where(eq(rewardAccountRevisions.rewardAccountId, rewardAccountId))
		.orderBy(desc(rewardAccountRevisions.revisionNo))
		.limit(1);
	if (!latestRev) return null;

	const balanceUnits = await deriveRewardPointBalanceInTransaction(
		tx,
		rewardAccountId,
	);
	const balancePoints = formatUnitsToDecimal(balanceUnits, 4);

	const rate = parseConversionRate(latestRev.defaultConversionRate);
	const estimatedValueCents = roundHalfUpToEconomicCents(
		balanceUnits,
		rate.units,
	);

	return {
		rewardAccountId: account.id,
		code: account.code,
		status: latestRev.status as "ACTIVE" | "ARCHIVED",
		displayName: latestRev.displayName,
		provider: latestRev.provider,
		unitName: latestRev.unitName,
		creditCardId: account.creditCardId,
		defaultConversionRate: latestRev.defaultConversionRate,
		balancePoints,
		estimatedCurrentValue: formatUnitsToDecimal(estimatedValueCents, 2),
		revisionNo: latestRev.revisionNo,
		occurredAt: latestRev.occurredAt,
		createdAt: account.createdAt,
	};
}

// ============================================================================
// Create
// ============================================================================

export async function createRewardAccountInTransaction(
	tx: DatabaseTransaction,
	params: {
		userId: string;
		code: string;
		displayName: string;
		provider: string;
		unitName: string;
		creditCardId: string | null;
		defaultConversionRate: string;
		note: string | null;
		occurredAt: Date;
		idempotencyKey: string;
	},
): Promise<{ account: RewardAccountReadModel; idempotentReplay: boolean }> {
	const {
		userId,
		code,
		displayName,
		provider,
		unitName,
		creditCardId,
		defaultConversionRate,
		note,
		occurredAt,
		idempotencyKey,
	} = params;

	// Early replay (unlocked): a historical CREATE key must replay exactly,
	// even after later lifecycle changes.
	const [earlyRev] = await tx
		.select()
		.from(rewardAccountRevisions)
		.where(
			and(
				eq(rewardAccountRevisions.userId, userId),
				eq(rewardAccountRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	const tryReplay = async (rev: typeof rewardAccountRevisions.$inferSelect) => {
		if (rev.revisionNo !== 1 || rev.operation !== "CREATE") {
			throw new RewardError(
				"REWARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key was already used for a different reward account operation",
			);
		}
		const candidateFingerprint = await calculateRewardAccountCreateFingerprint({
			userId,
			code,
			creditCardId,
			displayName,
			provider,
			unitName,
			defaultConversionRate,
			note,
			occurredAt,
		});
		if (candidateFingerprint !== rev.revisionFingerprint) {
			throw new RewardError(
				"REWARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key reused with a different reward account CREATE payload",
			);
		}
		const readModel = await buildRewardAccountReadModelInTransaction(
			tx,
			rev.rewardAccountId,
		);
		if (!readModel) {
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Failed to build replayed reward account read model",
			);
		}
		return { account: readModel, idempotentReplay: true as const };
	};

	if (earlyRev) return tryReplay(earlyRev);

	if (creditCardId) {
		const [card] = await tx
			.select({ id: creditCards.id })
			.from(creditCards)
			.where(
				and(eq(creditCards.id, creditCardId), eq(creditCards.userId, userId)),
			)
			.limit(1);
		if (!card) {
			throw new RewardError(
				"REWARD_INVALID_INPUT",
				`Credit card "${creditCardId}" not found`,
			);
		}
	}

	// Second replay under a lock-free but authoritative re-check (account
	// codes are unique per user; the DB unique index is the final authority
	// for races).
	const [secondRev] = await tx
		.select()
		.from(rewardAccountRevisions)
		.where(
			and(
				eq(rewardAccountRevisions.userId, userId),
				eq(rewardAccountRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	if (secondRev) return tryReplay(secondRev);

	const [insertedAccount] = await tx
		.insert(rewardAccounts)
		.values({ userId, code, creditCardId })
		.returning();
	if (!insertedAccount) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Failed to create reward account",
		);
	}

	const fingerprint = await calculateRewardAccountCreateFingerprint({
		userId,
		code,
		creditCardId,
		displayName,
		provider,
		unitName,
		defaultConversionRate,
		note,
		occurredAt,
	});

	const [insertedRev] = await tx
		.insert(rewardAccountRevisions)
		.values({
			userId,
			rewardAccountId: insertedAccount.id,
			revisionNo: 1,
			previousRevisionId: null,
			operation: "CREATE",
			status: "ACTIVE",
			displayName,
			provider,
			unitName,
			defaultConversionRate,
			note,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: fingerprint,
		})
		.returning();
	if (!insertedRev) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Failed to create reward account revision",
		);
	}

	const readModel = await buildRewardAccountReadModelInTransaction(
		tx,
		insertedAccount.id,
	);
	if (!readModel) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Failed to build newly created reward account read model",
		);
	}
	return { account: readModel, idempotentReplay: false };
}

export async function createRewardAccount(
	params: CreateRewardAccountParams,
): Promise<{ account: RewardAccountReadModel; idempotentReplay: boolean }> {
	// All DB-independent validation runs here, before runRewardsTransaction.
	const validUserId = validateRewardCanonicalUuid(params.userId, "userId");
	const validCode = validateRewardAccountCode(params.code);
	const validDisplayName = validateRewardRequiredText(
		params.displayName,
		"displayName",
		120,
	);
	const validProvider = validateRewardRequiredText(
		params.provider,
		"provider",
		120,
	);
	const validUnitName = validateRewardRequiredText(
		params.unitName,
		"unitName",
		40,
	);
	const validCreditCardId =
		params.creditCardId === undefined || params.creditCardId === null
			? null
			: validateRewardCanonicalUuid(params.creditCardId, "creditCardId");
	const validRate = validateDefaultConversionRateForCreate(
		params.defaultConversionRate,
	);
	const validNote = validateRewardOptionalText(params.note, "note", 500);
	const validOccurredAt = validateRewardOccurredAt(params.occurredAt);
	const validIdempotencyKey = validateRewardIdempotencyKey(
		params.idempotencyKey,
	);

	return runRewardsTransaction(params.db, (tx) =>
		createRewardAccountInTransaction(tx, {
			userId: validUserId,
			code: validCode,
			displayName: validDisplayName,
			provider: validProvider,
			unitName: validUnitName,
			creditCardId: validCreditCardId,
			defaultConversionRate: validRate,
			note: validNote,
			occurredAt: validOccurredAt,
			idempotencyKey: validIdempotencyKey,
		}),
	);
}

// ============================================================================
// Update
// ============================================================================

export async function updateRewardAccount(
	params: UpdateRewardAccountParams,
): Promise<{ account: RewardAccountReadModel; idempotentReplay: boolean }> {
	const userId = validateRewardCanonicalUuid(params.userId, "userId");
	const rewardAccountId = validateRewardCanonicalUuid(
		params.rewardAccountId,
		"rewardAccountId",
	);
	const expectedRevisionNo = validateRewardExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const displayName = validateRewardRequiredText(
		params.displayName,
		"displayName",
		120,
	);
	const provider = validateRewardRequiredText(params.provider, "provider", 120);
	const unitName = validateRewardRequiredText(params.unitName, "unitName", 40);
	// Only CREATE defaults an omitted rate to 1.000000. UPDATE must preserve
	// whatever the account's current/historical rate already is -- resolved
	// below, once the target revision (fresh or historical replay) is known.
	const rateOverride = validateDefaultConversionRateOverrideForUpdate(
		params.defaultConversionRate,
	);
	const note = validateRewardOptionalText(params.note, "note", 500);
	const occurredAt = validateRewardOccurredAt(params.occurredAt);
	const idempotencyKey = validateRewardIdempotencyKey(params.idempotencyKey);

	return runRewardsTransaction(params.db, async (tx) => {
		const tryReplay = async (
			rev: typeof rewardAccountRevisions.$inferSelect,
		) => {
			if (rev.operation !== "UPDATE") {
				throw new RewardError(
					"REWARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key was already used for a different reward account operation",
				);
			}
			// Historical replay: if the caller omitted the rate this time,
			// reconstruct the candidate fingerprint using THAT historical
			// UPDATE revision's own stored rate, not the account's current
			// latest rate (which may have changed since).
			const defaultConversionRate = rateOverride ?? rev.defaultConversionRate;
			const candidateFingerprint =
				await calculateRewardAccountUpdateFingerprint({
					userId,
					rewardAccountId,
					expectedRevisionNo,
					displayName,
					provider,
					unitName,
					defaultConversionRate,
					note,
					occurredAt,
				});
			if (candidateFingerprint !== rev.revisionFingerprint) {
				throw new RewardError(
					"REWARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different reward account UPDATE payload",
				);
			}
			const readModel = await buildRewardAccountReadModelInTransaction(
				tx,
				rewardAccountId,
			);
			if (!readModel) {
				throw new RewardError(
					"REWARD_INVALID_STATE",
					"Failed to build replayed reward account read model",
				);
			}
			return { account: readModel, idempotentReplay: true as const };
		};

		const [earlyRev] = await tx
			.select()
			.from(rewardAccountRevisions)
			.where(
				and(
					eq(rewardAccountRevisions.rewardAccountId, rewardAccountId),
					eq(rewardAccountRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		if (earlyRev) return tryReplay(earlyRev);

		const [account] = await tx
			.select()
			.from(rewardAccounts)
			.where(
				and(
					eq(rewardAccounts.id, rewardAccountId),
					eq(rewardAccounts.userId, userId),
				),
			)
			.for("update");
		if (!account) {
			throw new RewardError(
				"REWARD_ACCOUNT_NOT_FOUND",
				`Reward account "${rewardAccountId}" not found`,
			);
		}

		const [secondRev] = await tx
			.select()
			.from(rewardAccountRevisions)
			.where(
				and(
					eq(rewardAccountRevisions.rewardAccountId, rewardAccountId),
					eq(rewardAccountRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		if (secondRev) return tryReplay(secondRev);

		const [latestRev] = await tx
			.select()
			.from(rewardAccountRevisions)
			.where(eq(rewardAccountRevisions.rewardAccountId, rewardAccountId))
			.orderBy(desc(rewardAccountRevisions.revisionNo))
			.limit(1);
		if (!latestRev) {
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Reward account has no revisions",
			);
		}
		if (latestRev.status !== "ACTIVE") {
			throw new RewardError(
				"REWARD_ACCOUNT_NOT_ACTIVE",
				`Reward account "${rewardAccountId}" is not ACTIVE`,
			);
		}
		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new RewardError(
				"REWARD_ACCOUNT_REVISION_CONFLICT",
				`Expected reward account revision ${expectedRevisionNo} but found ${latestRev.revisionNo}`,
			);
		}

		// Fresh UPDATE: an omitted rate preserves the account's current latest
		// rate -- it must never silently reset to the CREATE default.
		const effectiveDefaultConversionRate =
			rateOverride ?? latestRev.defaultConversionRate;

		const fingerprint = await calculateRewardAccountUpdateFingerprint({
			userId,
			rewardAccountId,
			expectedRevisionNo,
			displayName,
			provider,
			unitName,
			defaultConversionRate: effectiveDefaultConversionRate,
			note,
			occurredAt,
		});

		await tx.insert(rewardAccountRevisions).values({
			userId,
			rewardAccountId,
			revisionNo: latestRev.revisionNo + 1,
			previousRevisionId: latestRev.id,
			operation: "UPDATE",
			status: "ACTIVE",
			displayName,
			provider,
			unitName,
			defaultConversionRate: effectiveDefaultConversionRate,
			note,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: fingerprint,
		});

		const readModel = await buildRewardAccountReadModelInTransaction(
			tx,
			rewardAccountId,
		);
		if (!readModel) {
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Failed to build updated reward account read model",
			);
		}
		return { account: readModel, idempotentReplay: false };
	});
}

// ============================================================================
// Archive
// ============================================================================

export async function archiveRewardAccount(
	params: ArchiveRewardAccountParams,
): Promise<{ account: RewardAccountReadModel; idempotentReplay: boolean }> {
	const userId = validateRewardCanonicalUuid(params.userId, "userId");
	const rewardAccountId = validateRewardCanonicalUuid(
		params.rewardAccountId,
		"rewardAccountId",
	);
	const expectedRevisionNo = validateRewardExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const occurredAt = validateRewardOccurredAt(params.occurredAt);
	const idempotencyKey = validateRewardIdempotencyKey(params.idempotencyKey);

	return runRewardsTransaction(params.db, async (tx) => {
		const tryReplay = async (
			rev: typeof rewardAccountRevisions.$inferSelect,
		) => {
			if (rev.operation !== "ARCHIVE") {
				throw new RewardError(
					"REWARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key was already used for a different reward account operation",
				);
			}
			const candidateFingerprint =
				await calculateRewardAccountArchiveFingerprint({
					userId,
					rewardAccountId,
					expectedRevisionNo,
					occurredAt,
				});
			if (candidateFingerprint !== rev.revisionFingerprint) {
				throw new RewardError(
					"REWARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different reward account ARCHIVE payload",
				);
			}
			const readModel = await buildRewardAccountReadModelInTransaction(
				tx,
				rewardAccountId,
			);
			if (!readModel) {
				throw new RewardError(
					"REWARD_INVALID_STATE",
					"Failed to build replayed reward account read model",
				);
			}
			return { account: readModel, idempotentReplay: true as const };
		};

		const [earlyRev] = await tx
			.select()
			.from(rewardAccountRevisions)
			.where(
				and(
					eq(rewardAccountRevisions.rewardAccountId, rewardAccountId),
					eq(rewardAccountRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		if (earlyRev) return tryReplay(earlyRev);

		const [account] = await tx
			.select()
			.from(rewardAccounts)
			.where(
				and(
					eq(rewardAccounts.id, rewardAccountId),
					eq(rewardAccounts.userId, userId),
				),
			)
			.for("update");
		if (!account) {
			throw new RewardError(
				"REWARD_ACCOUNT_NOT_FOUND",
				`Reward account "${rewardAccountId}" not found`,
			);
		}

		const [secondRev] = await tx
			.select()
			.from(rewardAccountRevisions)
			.where(
				and(
					eq(rewardAccountRevisions.rewardAccountId, rewardAccountId),
					eq(rewardAccountRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		if (secondRev) return tryReplay(secondRev);

		const [latestRev] = await tx
			.select()
			.from(rewardAccountRevisions)
			.where(eq(rewardAccountRevisions.rewardAccountId, rewardAccountId))
			.orderBy(desc(rewardAccountRevisions.revisionNo))
			.limit(1);
		if (!latestRev) {
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Reward account has no revisions",
			);
		}
		if (latestRev.status !== "ACTIVE") {
			throw new RewardError(
				"REWARD_ACCOUNT_NOT_ACTIVE",
				`Reward account "${rewardAccountId}" is already ARCHIVED`,
			);
		}
		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new RewardError(
				"REWARD_ACCOUNT_REVISION_CONFLICT",
				`Expected reward account revision ${expectedRevisionNo} but found ${latestRev.revisionNo}`,
			);
		}

		const balanceUnits = await deriveRewardPointBalanceInTransaction(
			tx,
			rewardAccountId,
		);
		if (balanceUnits !== 0n) {
			throw new RewardError(
				"REWARD_ACCOUNT_CONFLICT",
				`Cannot archive reward account "${rewardAccountId}" with non-zero point balance ${formatUnitsToDecimal(balanceUnits, 4)}`,
			);
		}

		const fingerprint = await calculateRewardAccountArchiveFingerprint({
			userId,
			rewardAccountId,
			expectedRevisionNo,
			occurredAt,
		});

		await tx.insert(rewardAccountRevisions).values({
			userId,
			rewardAccountId,
			revisionNo: latestRev.revisionNo + 1,
			previousRevisionId: latestRev.id,
			operation: "ARCHIVE",
			status: "ARCHIVED",
			displayName: latestRev.displayName,
			provider: latestRev.provider,
			unitName: latestRev.unitName,
			defaultConversionRate: latestRev.defaultConversionRate,
			note: latestRev.note,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: fingerprint,
		});

		const readModel = await buildRewardAccountReadModelInTransaction(
			tx,
			rewardAccountId,
		);
		if (!readModel) {
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Failed to build archived reward account read model",
			);
		}
		return { account: readModel, idempotentReplay: false };
	});
}

// ============================================================================
// Reads
// ============================================================================

export async function getRewardAccount(
	params: GetRewardAccountParams,
): Promise<RewardAccountReadModel | null> {
	const userId = validateRewardCanonicalUuid(params.userId, "userId");
	const rewardAccountId = validateRewardCanonicalUuid(
		params.rewardAccountId,
		"rewardAccountId",
	);

	return runRewardsReadTransaction(params.db, async (tx) => {
		const [account] = await tx
			.select()
			.from(rewardAccounts)
			.where(
				and(
					eq(rewardAccounts.id, rewardAccountId),
					eq(rewardAccounts.userId, userId),
				),
			)
			.limit(1);
		if (!account) return null;
		return buildRewardAccountReadModelInTransaction(tx, account.id);
	});
}

export async function listRewardAccounts(
	params: ListRewardAccountsParams,
): Promise<RewardAccountReadModel[]> {
	const userId = validateRewardCanonicalUuid(params.userId, "userId");
	const status = validateRewardAccountStatusFilter(params.status);

	return runRewardsReadTransaction(params.db, async (tx) => {
		const accounts = await tx
			.select()
			.from(rewardAccounts)
			.where(eq(rewardAccounts.userId, userId))
			.orderBy(desc(rewardAccounts.createdAt), asc(rewardAccounts.id));

		const results: RewardAccountReadModel[] = [];
		for (const account of accounts) {
			const readModel = await buildRewardAccountReadModelInTransaction(
				tx,
				account.id,
			);
			if (!readModel) continue;
			if (status !== undefined && readModel.status !== status) continue;
			results.push(readModel);
		}
		return results;
	});
}

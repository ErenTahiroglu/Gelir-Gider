import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	creditCardStatementRevisions,
	creditCardStatements,
} from "../db/schema/credit-cards";
import { midasAccounts, midasBuckets } from "../db/schema/midas";
import {
	personObligationRevisions,
	personObligations,
} from "../db/schema/people";
import { formatCentsToMoney, parsePositiveMoneyString } from "../ledger/money";
import { allocateLongTermInvestment } from "../long-term/service";
import {
	createMidasAllocationTransferInTransaction,
	getMidasLiquidityStateInTransaction,
} from "../midas/service";
import { listBoundedShortTermGoals } from "../short-term-goals/product-read";
import { fundShortTermGoal } from "../short-term-goals/service";
import { PeopleError } from "./errors";
import { listPersonObligations } from "./obligations";
import { recordPersonReceivableSettlement } from "./settlements";
import { validateCanonicalUuid } from "./validation";

export interface SettlePersonReceivablesParams {
	db: Database;
	userId: string;
	personId: string;
	cashAmount: string;
	destinationAssetAccountId: string;
	occurredAt?: Date | undefined;
	idempotencyKey: string;
	isCash: boolean;
}

export interface SettlementRoutingItem {
	destination: "CREDIT_CARD_RESERVE" | "SHORT_TERM_GOAL" | "LONG_TERM";
	amount: string;
}

export interface SettlePersonReceivablesResult {
	cashReceived: string;
	receivableApplied: string;
	excess: string;
	remainingReceivable: string;
	routing: SettlementRoutingItem[];
}

export async function settlePersonReceivables(
	params: SettlePersonReceivablesParams,
): Promise<SettlePersonReceivablesResult> {
	const { db } = params;
	const userId = validateCanonicalUuid(params.userId, "userId");
	const personId = validateCanonicalUuid(params.personId, "personId");
	const destinationAssetAccountId = validateCanonicalUuid(
		params.destinationAssetAccountId,
		"destinationAssetAccountId",
	);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey) {
		throw new PeopleError("PEOPLE_INVALID_INPUT", "idempotencyKey is required");
	}

	const parsedCash = parsePositiveMoneyString(params.cashAmount);
	const totalCashCents = parsedCash.cents;
	const occurredAt = params.occurredAt ?? new Date();

	// 1. Fetch all ACTIVE RECEIVABLE obligations for person
	const openObligations = await listPersonObligations({
		db,
		userId,
		personId,
		direction: "RECEIVABLE",
		status: "OPEN",
	});

	const activeObligations = openObligations
		.map((ob) => ({
			obligationId: ob.obligationId,
			dueDate: ob.dueDate,
			remainingCents: parsePositiveMoneyString(ob.remainingAmount).cents,
		}))
		.filter((ob) => ob.remainingCents > 0n);

	// Deterministic sorting:
	// 1. dueDate ASC (NULLS LAST)
	// 2. obligationId ASC
	activeObligations.sort((a, b) => {
		if (a.dueDate && b.dueDate) {
			if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
		} else if (a.dueDate && !b.dueDate) {
			return -1;
		} else if (!a.dueDate && b.dueDate) {
			return 1;
		}

		return a.obligationId.localeCompare(b.obligationId);
	});

	// 2. Sequential allocation across obligations
	let remainingCashCents = totalCashCents;
	let totalAppliedCents = 0n;
	let totalExcessCents = 0n;

	if (activeObligations.length === 0) {
		totalExcessCents = totalCashCents;
	} else {
		for (let i = 0; i < activeObligations.length; i++) {
			const ob = activeObligations[i]!;
			const isLast = i === activeObligations.length - 1;

			if (remainingCashCents <= 0n) break;

			let toApplyCents: bigint;
			if (isLast) {
				// Last obligation absorbs whatever cash remains (which may overpay it)
				toApplyCents = remainingCashCents;
			} else {
				toApplyCents =
					remainingCashCents < ob.remainingCents
						? remainingCashCents
						: ob.remainingCents;
			}

			const childKey = `${idempotencyKey}:ob:${ob.obligationId}`;
			const settlement = await recordPersonReceivableSettlement({
				db,
				userId,
				obligationId: ob.obligationId,
				cashAmount: formatCentsToMoney(toApplyCents),
				destinationAssetAccountId,
				occurredAt,
				note: `Multi-obligation person settlement ${personId}`,
				idempotencyKey: childKey,
			});

			const appliedCents = parsePositiveMoneyString(
				settlement.settlement.appliedAmount,
			).cents;
			const excessCents = parsePositiveMoneyString(
				settlement.settlement.excessAmount,
			).cents;

			totalAppliedCents += appliedCents;
			totalExcessCents += excessCents;
			remainingCashCents -= toApplyCents;
		}
	}

	// 3. Excess Waterfall (only if non-cash and excess > 0)
	const routing: SettlementRoutingItem[] = [];
	let remainingWaterfallCents = totalExcessCents;

	if (!params.isCash && remainingWaterfallCents > 0n) {
		// 3.1 Credit Card Reserve shortfall for OPEN MIDAS_FUND statements
		const latestStatementRevisions = db
			.select({
				statementId: creditCardStatementRevisions.statementId,
				maxRev: sql<number>`max(${creditCardStatementRevisions.revisionNo})`.as(
					"max_rev",
				),
			})
			.from(creditCardStatementRevisions)
			.groupBy(creditCardStatementRevisions.statementId)
			.as("latest_stmt_rev");

		const openStatements = await db
			.select({
				statementId: creditCardStatements.id,
				midasAccountId: creditCardStatements.midasAccountId,
				midasReserveBucketId: creditCardStatements.midasReserveBucketId,
				statementAmount: creditCardStatementRevisions.statementAmount,
				dueDate: creditCardStatementRevisions.dueDate,
			})
			.from(creditCardStatements)
			.innerJoin(
				creditCardStatementRevisions,
				eq(creditCardStatements.id, creditCardStatementRevisions.statementId),
			)
			.innerJoin(
				latestStatementRevisions,
				and(
					eq(
						creditCardStatementRevisions.statementId,
						latestStatementRevisions.statementId,
					),
					eq(
						creditCardStatementRevisions.revisionNo,
						latestStatementRevisions.maxRev,
					),
				),
			)
			.where(
				and(
					eq(creditCardStatements.userId, userId),
					eq(creditCardStatementRevisions.status, "OPEN"),
				),
			)
			.orderBy(
				asc(creditCardStatementRevisions.dueDate),
				asc(creditCardStatements.id),
			);

		for (const stmt of openStatements) {
			if (remainingWaterfallCents <= 0n) break;
			if (!stmt.midasAccountId || !stmt.midasReserveBucketId) continue;

			// Check current balance of the reserve bucket
			const [bucket] = await db
				.select()
				.from(midasBuckets)
				.where(
					and(
						eq(midasBuckets.id, stmt.midasReserveBucketId),
						eq(midasBuckets.userId, userId),
					),
				);

			if (!bucket) continue;

			let bucketBalanceCents = 0n;
			await db.transaction(async (tx) => {
				const liq = await getMidasLiquidityStateInTransaction({
					tx,
					userId,
					midasAccountId: stmt.midasAccountId ?? undefined,
				});
				const bState = liq.buckets.find(
					(b) => b.bucketId === stmt.midasReserveBucketId,
				);
				if (bState) {
					bucketBalanceCents = parsePositiveMoneyString(bState.balance).cents;
				}
			});

			const stmtAmountCents = parsePositiveMoneyString(
				stmt.statementAmount,
			).cents;
			const shortfall = stmtAmountCents - bucketBalanceCents;

			if (shortfall > 0n) {
				const toFill =
					remainingWaterfallCents < shortfall
						? remainingWaterfallCents
						: shortfall;

				const reserveChildKey = `${idempotencyKey}:waterfall:reserve:${stmt.statementId}`;
				await db.transaction(async (tx) => {
					await createMidasAllocationTransferInTransaction({
						tx,
						userId,
						midasAccountId: stmt.midasAccountId!,
						fromBucketId: null,
						toBucketId: stmt.midasReserveBucketId!,
						amount: formatCentsToMoney(toFill),
						occurredAt,
						idempotencyKey: reserveChildKey,
						memo: "Waterfall reserve shortfall allocation",
					});
				});

				remainingWaterfallCents -= toFill;
				routing.push({
					destination: "CREDIT_CARD_RESERVE",
					amount: formatCentsToMoney(toFill),
				});
			}
		}

		// 3.2 Short-Term Goal Priority #1
		if (remainingWaterfallCents > 0n) {
			const stgResult = await listBoundedShortTermGoals({
				db,
				userId,
				status: "ACTIVE",
				limit: 50,
			});

			const eligibleGoal = stgResult.goals.find((g) => {
				if (g.status !== "ACTIVE" || g.fundingStatus === "TARGET_REACHED")
					return false;
				const remainingCents = parsePositiveMoneyString(
					g.remainingToTarget,
				).cents;
				return remainingCents > 0n;
			});

			if (eligibleGoal) {
				const toFill = remainingWaterfallCents;
				const stgChildKey = `${idempotencyKey}:waterfall:stg:${eligibleGoal.goalId}`;

				await fundShortTermGoal({
					db,
					userId,
					goalId: eligibleGoal.goalId,
					amount: formatCentsToMoney(toFill),
					idempotencyKey: stgChildKey,
					occurredAt,
					memo: "Waterfall short-term goal allocation",
				});

				remainingWaterfallCents = 0n;
				routing.push({
					destination: "SHORT_TERM_GOAL",
					amount: formatCentsToMoney(toFill),
				});
			}
		}

		// 3.3 Long-Term Fallback
		if (remainingWaterfallCents > 0n) {
			const [midasAccount] = await db
				.select({ id: midasAccounts.id })
				.from(midasAccounts)
				.where(eq(midasAccounts.userId, userId))
				.limit(1);

			if (midasAccount) {
				const toFill = remainingWaterfallCents;
				const ltChildKey = `${idempotencyKey}:waterfall:lt`;

				await allocateLongTermInvestment({
					db,
					userId,
					midasAccountId: midasAccount.id,
					amount: formatCentsToMoney(toFill),
					idempotencyKey: ltChildKey,
					occurredAt,
					note: "Waterfall long-term allocation",
				});

				remainingWaterfallCents = 0n;
				routing.push({
					destination: "LONG_TERM",
					amount: formatCentsToMoney(toFill),
				});
			}
		}
	}

	// 4. Calculate final remaining receivable for person
	const postObligations = await listPersonObligations({
		db,
		userId,
		personId,
		direction: "RECEIVABLE",
		status: "OPEN",
	});

	let remainingReceivableCents = 0n;
	for (const ob of postObligations) {
		remainingReceivableCents += parsePositiveMoneyString(
			ob.remainingAmount,
		).cents;
	}

	return {
		cashReceived: formatCentsToMoney(totalCashCents),
		receivableApplied: formatCentsToMoney(totalAppliedCents),
		excess: formatCentsToMoney(totalExcessCents),
		remainingReceivable: formatCentsToMoney(remainingReceivableCents),
		routing,
	};
}

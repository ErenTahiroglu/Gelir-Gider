import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	creditCardStatementRevisions,
	creditCardStatements,
} from "../db/schema/credit-cards";
import { midasAccounts } from "../db/schema/midas";
import {
	people,
	personObligationRevisions,
	personObligations,
	personReceivableSettlementRequests,
	personRevisions,
	personSettlementRevisions,
	personSettlements,
} from "../db/schema/people";
import { formatCentsToMoney, parsePositiveMoneyString } from "../ledger/money";
import { allocateLongTermInvestmentInTransaction } from "../long-term/service";
import {
	createMidasAllocationTransferInTransaction,
	getMidasLiquidityStateInTransaction,
} from "../midas/service";
import { listBoundedShortTermGoals } from "../short-term-goals/product-read";
import { fundShortTermGoalInTransaction } from "../short-term-goals/service";
import { runPeopleTransaction } from "./boundary";
import { PeopleError } from "./errors";
import { calculatePersonReceivableSettlementRequestFingerprint } from "./fingerprint";
import { recordPersonReceivableSettlementInTransaction } from "./settlements";
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
	const userId = validateCanonicalUuid(params.userId, "userId");
	const personId = validateCanonicalUuid(params.personId, "personId");
	const destinationAssetAccountId = validateCanonicalUuid(
		params.destinationAssetAccountId,
		"destinationAssetAccountId",
	);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"idempotencyKey is required and must be at most 128 characters",
		);
	}

	const parsedCash = parsePositiveMoneyString(params.cashAmount);
	const totalCashCents = parsedCash.cents;
	if (totalCashCents <= 0n) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"cashAmount must be greater than zero",
		);
	}
	const occurredAt = params.occurredAt ?? new Date();

	// Calculate deterministic root request fingerprint
	const requestFingerprint =
		await calculatePersonReceivableSettlementRequestFingerprint({
			userId,
			personId,
			cashAmount: formatCentsToMoney(totalCashCents),
			destinationAssetAccountId,
			isCash: params.isCash,
			occurredAt,
		});

	return runPeopleTransaction(params.db, async (tx: DatabaseTransaction) => {
		// 1. Root Idempotency Check
		const [existingRequest] = await tx
			.select()
			.from(personReceivableSettlementRequests)
			.where(
				and(
					eq(personReceivableSettlementRequests.userId, userId),
					eq(personReceivableSettlementRequests.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingRequest) {
			if (existingRequest.requestFingerprint === requestFingerprint) {
				return existingRequest.resultJson as SettlePersonReceivablesResult;
			}
			throw new PeopleError(
				"PEOPLE_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different settlement request payload",
			);
		}

		// 2. Lock Person & verify exists and active
		const [personRow] = await tx
			.select()
			.from(people)
			.where(and(eq(people.id, personId), eq(people.userId, userId)))
			.for("update")
			.limit(1);

		if (!personRow) {
			throw new PeopleError(
				"PEOPLE_NOT_FOUND",
				`Person "${personId}" not found`,
			);
		}

		const [latestPersonRev] = await tx
			.select()
			.from(personRevisions)
			.where(eq(personRevisions.personId, personId))
			.orderBy(desc(personRevisions.revisionNo))
			.limit(1);

		if (!latestPersonRev || latestPersonRev.status !== "ACTIVE") {
			throw new PeopleError(
				"PEOPLE_NOT_ACTIVE",
				`Person "${personId}" is not active`,
			);
		}

		// 3. Non-cash must actually be Midas-linked asset account
		let resolvedMidasAccount: { id: string; ledgerAccountId: string } | null =
			null;
		if (!params.isCash) {
			const [midasAccount] = await tx
				.select({
					id: midasAccounts.id,
					ledgerAccountId: midasAccounts.ledgerAccountId,
				})
				.from(midasAccounts)
				.where(eq(midasAccounts.userId, userId))
				.limit(1);

			if (!midasAccount) {
				throw new PeopleError(
					"PEOPLE_LEDGER_ACCOUNT_INVALID",
					"User has no Midas account configured for non-cash settlement",
				);
			}

			if (destinationAssetAccountId !== midasAccount.ledgerAccountId) {
				throw new PeopleError(
					"PEOPLE_LEDGER_ACCOUNT_INVALID",
					`Non-cash settlement destination must be the user's Midas-linked asset account (${midasAccount.ledgerAccountId})`,
				);
			}
			resolvedMidasAccount = midasAccount;
		}

		// 4. Fetch and Lock OPEN RECEIVABLE obligations for person
		const obligationRows = await tx
			.select({
				id: personObligations.id,
				createdAt: personObligations.createdAt,
			})
			.from(personObligations)
			.where(
				and(
					eq(personObligations.userId, userId),
					eq(personObligations.personId, personId),
					eq(personObligations.direction, "RECEIVABLE"),
				),
			)
			.for("update");

		interface ActiveObligationItem {
			obligationId: string;
			dueDate: string | null;
			createdAt: Date;
			remainingCents: bigint;
		}

		const activeObligations: ActiveObligationItem[] = [];

		for (const ob of obligationRows) {
			const [latestObligationRev] = await tx
				.select()
				.from(personObligationRevisions)
				.where(eq(personObligationRevisions.obligationId, ob.id))
				.orderBy(desc(personObligationRevisions.revisionNo))
				.limit(1);

			if (!latestObligationRev || latestObligationRev.operation === "VOID") {
				continue;
			}

			const settlements = await tx
				.select({ id: personSettlements.id })
				.from(personSettlements)
				.where(eq(personSettlements.obligationId, ob.id));

			let activeSettledCents = 0n;
			for (const s of settlements) {
				const [latestSetRev] = await tx
					.select()
					.from(personSettlementRevisions)
					.where(eq(personSettlementRevisions.settlementId, s.id))
					.orderBy(desc(personSettlementRevisions.revisionNo))
					.limit(1);

				if (latestSetRev && latestSetRev.operation !== "VOID") {
					activeSettledCents += parsePositiveMoneyString(
						latestSetRev.appliedAmount,
					).cents;
				}
			}

			const principalCents = parsePositiveMoneyString(
				latestObligationRev.principalAmount,
			).cents;
			const remainingCents = principalCents - activeSettledCents;

			if (remainingCents > 0n) {
				activeObligations.push({
					obligationId: ob.id,
					dueDate: latestObligationRev.dueDate,
					createdAt: ob.createdAt,
					remainingCents,
				});
			}
		}

		// Requirement 6: No open receivables -> fail closed with 409
		if (activeObligations.length === 0) {
			throw new PeopleError(
				"PEOPLE_NO_OPEN_RECEIVABLES",
				`Person "${personId}" has no open receivable obligations to settle`,
			);
		}

		// Requirement 7: Deterministic order:
		// 1. dueDate ASC (NULLS LAST)
		// 2. createdAt ASC
		// 3. obligationId ASC
		activeObligations.sort((a, b) => {
			if (a.dueDate && b.dueDate) {
				if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
			} else if (a.dueDate && !b.dueDate) {
				return -1;
			} else if (!a.dueDate && b.dueDate) {
				return 1;
			}

			if (a.createdAt.getTime() !== b.createdAt.getTime()) {
				return a.createdAt.getTime() - b.createdAt.getTime();
			}

			return a.obligationId.localeCompare(b.obligationId);
		});

		// 5. Sequential allocation across obligations inside root transaction
		let remainingCashCents = totalCashCents;
		let totalAppliedCents = 0n;
		let totalExcessCents = 0n;

		for (let i = 0; i < activeObligations.length; i++) {
			const ob = activeObligations[i]!;
			const isLast = i === activeObligations.length - 1;

			if (remainingCashCents <= 0n) break;

			let toApplyCents: bigint;
			if (isLast) {
				// Last obligation absorbs whatever cash remains (handles overpayment)
				toApplyCents = remainingCashCents;
			} else {
				toApplyCents =
					remainingCashCents < ob.remainingCents
						? remainingCashCents
						: ob.remainingCents;
			}

			const childKey = `${idempotencyKey}:ob:${ob.obligationId}`;
			const settlement = await recordPersonReceivableSettlementInTransaction({
				tx,
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

		// 6. Excess Waterfall (only non-cash and excess > 0)
		const routing: SettlementRoutingItem[] = [];
		let remainingWaterfallCents = totalExcessCents;

		if (!params.isCash && remainingWaterfallCents > 0n) {
			// 6.1 Credit Card Reserve shortfall for OPEN MIDAS_FUND statements
			const latestStatementRevisions = tx
				.select({
					statementId: creditCardStatementRevisions.statementId,
					maxRev:
						sql<number>`max(${creditCardStatementRevisions.revisionNo})`.as(
							"max_rev",
						),
				})
				.from(creditCardStatementRevisions)
				.groupBy(creditCardStatementRevisions.statementId)
				.as("latest_stmt_rev");

			const openStatements = await tx
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
						eq(creditCardStatementRevisions.reservePlacement, "MIDAS_FUND"),
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
				const liq = await getMidasLiquidityStateInTransaction({
					tx,
					userId,
					midasAccountId: stmt.midasAccountId,
				});
				const bState = liq.buckets.find(
					(b) => b.bucketId === stmt.midasReserveBucketId,
				);
				const bucketBalanceCents = bState
					? parsePositiveMoneyString(bState.balance).cents
					: 0n;

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
					await createMidasAllocationTransferInTransaction({
						tx,
						userId,
						midasAccountId: stmt.midasAccountId,
						fromBucketId: null,
						toBucketId: stmt.midasReserveBucketId,
						amount: formatCentsToMoney(toFill),
						occurredAt,
						idempotencyKey: reserveChildKey,
						memo: "Waterfall reserve shortfall allocation",
					});

					remainingWaterfallCents -= toFill;
					routing.push({
						destination: "CREDIT_CARD_RESERVE",
						amount: formatCentsToMoney(toFill),
					});
				}
			}

			// 6.2 Short-Term Goal Priority #1 (Capped to goal remaining)
			if (remainingWaterfallCents > 0n) {
				const stgResult = await listBoundedShortTermGoals({
					db: tx,
					userId,
					status: "ACTIVE",
					limit: 50,
				});

				const eligibleGoal = stgResult.goals.find((g) => {
					if (g.status !== "ACTIVE" || g.fundingStatus === "TARGET_REACHED") {
						return false;
					}
					const remainingCents = parsePositiveMoneyString(
						g.remainingToTarget,
					).cents;
					return remainingCents > 0n;
				});

				if (eligibleGoal) {
					const goalRemainingCents = parsePositiveMoneyString(
						eligibleGoal.remainingToTarget,
					).cents;
					const toFillGoal =
						remainingWaterfallCents < goalRemainingCents
							? remainingWaterfallCents
							: goalRemainingCents;

					if (toFillGoal > 0n) {
						const stgChildKey = `${idempotencyKey}:waterfall:stg:${eligibleGoal.goalId}`;
						await fundShortTermGoalInTransaction({
							tx,
							userId,
							goalId: eligibleGoal.goalId,
							amount: formatCentsToMoney(toFillGoal),
							idempotencyKey: stgChildKey,
							occurredAt,
							memo: "Waterfall short-term goal allocation",
						});

						remainingWaterfallCents -= toFillGoal;
						routing.push({
							destination: "SHORT_TERM_GOAL",
							amount: formatCentsToMoney(toFillGoal),
						});
					}
				}
			}

			// 6.3 Long-Term Fallback for residual
			if (remainingWaterfallCents > 0n && resolvedMidasAccount) {
				const ltToFill = remainingWaterfallCents;
				const ltChildKey = `${idempotencyKey}:waterfall:lt`;

				await allocateLongTermInvestmentInTransaction(tx, {
					userId,
					midasAccountId: resolvedMidasAccount.id,
					amount: formatCentsToMoney(ltToFill),
					destinationLabel: null,
					idempotencyKey: ltChildKey,
					occurredAt,
					note: "Waterfall long-term allocation",
				});

				remainingWaterfallCents = 0n;
				routing.push({
					destination: "LONG_TERM",
					amount: formatCentsToMoney(ltToFill),
				});
			}
		}

		// 7. Calculate post-settlement remaining receivable for person
		let remainingReceivableCents = 0n;
		for (const ob of obligationRows) {
			const settlements = await tx
				.select({ id: personSettlements.id })
				.from(personSettlements)
				.where(eq(personSettlements.obligationId, ob.id));

			let activeSettled = 0n;
			for (const s of settlements) {
				const [latestSetRev] = await tx
					.select()
					.from(personSettlementRevisions)
					.where(eq(personSettlementRevisions.settlementId, s.id))
					.orderBy(desc(personSettlementRevisions.revisionNo))
					.limit(1);

				if (latestSetRev && latestSetRev.operation !== "VOID") {
					activeSettled += parsePositiveMoneyString(
						latestSetRev.appliedAmount,
					).cents;
				}
			}

			const [latestObligationRev] = await tx
				.select()
				.from(personObligationRevisions)
				.where(eq(personObligationRevisions.obligationId, ob.id))
				.orderBy(desc(personObligationRevisions.revisionNo))
				.limit(1);

			if (latestObligationRev && latestObligationRev.operation !== "VOID") {
				const principal = parsePositiveMoneyString(
					latestObligationRev.principalAmount,
				).cents;
				const rem = principal - activeSettled;
				if (rem > 0n) {
					remainingReceivableCents += rem;
				}
			}
		}

		const result: SettlePersonReceivablesResult = {
			cashReceived: formatCentsToMoney(totalCashCents),
			receivableApplied: formatCentsToMoney(totalAppliedCents),
			excess: formatCentsToMoney(totalExcessCents),
			remainingReceivable: formatCentsToMoney(remainingReceivableCents),
			routing,
		};

		// 8. Persist root settlement receipt
		await tx.insert(personReceivableSettlementRequests).values({
			userId,
			personId,
			idempotencyKey,
			requestFingerprint,
			cashAmount: formatCentsToMoney(totalCashCents),
			destinationAssetAccountId,
			isCash: params.isCash,
			occurredAt,
			resultJson: result,
		});

		return result;
	});
}

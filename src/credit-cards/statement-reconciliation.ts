import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	CC_STATEMENT_RECON_ADJUSTMENT_KINDS,
	CC_STATEMENT_RECON_COMPONENT_TYPES,
	CC_STATEMENT_RECON_OWNERSHIPS,
	type CcStatementReconAdjustmentKind,
	type CcStatementReconComponentType,
	type CcStatementReconOwnership,
	creditCardStatementReconciliationComponents,
	creditCardStatementReconciliationRevisions,
	creditCardStatementReconciliationSeals,
	creditCardStatementReconciliations,
} from "../db/schema/credit-card-statement-reconciliation";
import {
	creditCardStatementRevisions,
	creditCardStatements,
} from "../db/schema/credit-cards";
import { parsePositiveMoneyString } from "../ledger/money";
import { validateCcCanonicalUuid } from "./calendar";
import { CreditCardError } from "./errors";
import {
	calculateStatementReconciliationRevisionFingerprint,
	type ReconciliationComponentFingerprintInput,
} from "./reconciliation-fingerprint";

/**
 * CREDIT-CARD STATEMENT RECONCILIATION SERVICE
 *
 * Turns a statement revision's `statement_amount` into an EXPLICIT, STORED,
 * kurus-exact decomposition of PURCHASE + ADJUSTMENT components, each with
 * explicit ownership (PERSONAL or a specific external person). Budget V2 uses
 * only sealed, non-stale reconciliations; everything else is fail-closed.
 *
 * `reconcileStatement`  -- CREATE (rev #1) or SUPERSEDE (rev n+1) + seal, atomically
 * `voidStatementReconciliation` -- append a terminal VOID revision
 * `getStatementReconciliation`  -- effective status + authoritative components
 */

// ============================================================================
// Input / read model
// ============================================================================

export interface ReconciliationComponentInput {
	componentType: CcStatementReconComponentType;
	amount: string;
	ownership: CcStatementReconOwnership;
	personId?: string | null | undefined;
	purchaseEventId?: string | null | undefined;
	purchaseSplitRevisionId?: string | null | undefined;
	adjustmentKind?: CcStatementReconAdjustmentKind | null | undefined;
	note?: string | null | undefined;
}

export interface ReconcileStatementParams {
	db: Database;
	userId: string;
	statementId: string;
	/** MUST be the statement's current latest revision id. */
	statementRevisionId: string;
	components: ReconciliationComponentInput[];
	idempotencyKey: string;
	/** Required when superseding: the current latest reconciliation revision no. */
	expectedRevisionNo?: number | undefined;
	occurredAt?: Date | undefined;
}

export interface VoidStatementReconciliationParams {
	db: Database;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface ReconciliationComponentItem {
	componentNo: number;
	componentType: CcStatementReconComponentType;
	amount: string;
	ownership: CcStatementReconOwnership;
	personId: string | null;
	purchaseEventId: string | null;
	purchaseSplitRevisionId: string | null;
	adjustmentKind: CcStatementReconAdjustmentKind | null;
	note: string | null;
}

export interface StatementReconciliationRevisionItem {
	reconciliationId: string;
	revisionId: string;
	revisionNo: number;
	operation: "CREATE" | "SUPERSEDE" | "VOID";
	statementRevisionId: string;
	reconciledStatementAmount: string;
	componentCount: number;
	sealed: boolean;
	occurredAt: string;
}

export interface ReconcileStatementResult {
	revision: StatementReconciliationRevisionItem;
	components: ReconciliationComponentItem[];
	idempotentReplay: boolean;
}

export type StatementReconciliationStatus =
	| "NONE" // no reconciliation ever created
	| "UNSEALED" // latest revision has no seal (incomplete)
	| "VOIDED" // latest revision is a terminal VOID
	| "STALE" // sealed, but the statement was revised / re-amounted since
	| "RECONCILED"; // sealed and current

export interface StatementReconciliationView {
	statementId: string;
	status: StatementReconciliationStatus;
	revisionNo: number | null;
	statementRevisionId: string | null;
	reconciledStatementAmount: string | null;
	/** Present only when status is RECONCILED. */
	components: ReconciliationComponentItem[];
	/** kurus */
	personalCents: bigint;
	/** personId -> kurus */
	externalByPerson: Map<string, bigint>;
}

// ============================================================================
// Validation
// ============================================================================

function requireKey(idempotencyKey: string): string {
	const trimmed = idempotencyKey?.trim();
	if (!trimmed || trimmed.length > 128) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"idempotencyKey is required and must be 1..128 chars",
		);
	}
	return trimmed;
}

function validateOptionalOccurredAt(value: Date | undefined): Date | undefined {
	if (value === undefined) return undefined;
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

function validateNote(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 500) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"component note must be 1..500 chars",
		);
	}
	return trimmed;
}

interface NormalizedComponent {
	componentNo: number;
	componentType: CcStatementReconComponentType;
	amountNormalized: string;
	amountCents: bigint;
	ownership: CcStatementReconOwnership;
	personId: string | null;
	purchaseEventId: string | null;
	purchaseSplitRevisionId: string | null;
	adjustmentKind: CcStatementReconAdjustmentKind | null;
	note: string | null;
}

function normalizeComponents(
	raw: ReconciliationComponentInput[],
): NormalizedComponent[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"at least one reconciliation component is required",
		);
	}
	return raw.map((c, i) => {
		const componentNo = i + 1;
		if (
			!(CC_STATEMENT_RECON_COMPONENT_TYPES as readonly string[]).includes(
				c.componentType,
			)
		) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`component ${componentNo}: componentType must be one of ${CC_STATEMENT_RECON_COMPONENT_TYPES.join(", ")}`,
			);
		}
		if (
			!(CC_STATEMENT_RECON_OWNERSHIPS as readonly string[]).includes(
				c.ownership,
			)
		) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`component ${componentNo}: ownership must be one of ${CC_STATEMENT_RECON_OWNERSHIPS.join(", ")}`,
			);
		}
		let amountCents: bigint;
		let amountNormalized: string;
		try {
			const p = parsePositiveMoneyString(c.amount);
			amountCents = p.cents;
			amountNormalized = p.normalized;
		} catch (e) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`component ${componentNo}: amount must be a positive money string (${
					e instanceof Error ? e.message : String(e)
				})`,
			);
		}

		const personId =
			c.ownership === "EXTERNAL_PERSON"
				? validateCcCanonicalUuid(
						c.personId,
						`component ${componentNo} personId`,
					)
				: null;
		if (c.ownership === "PERSONAL" && c.personId != null) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`component ${componentNo}: PERSONAL ownership must not carry a personId`,
			);
		}

		let purchaseEventId: string | null = null;
		let purchaseSplitRevisionId: string | null = null;
		let adjustmentKind: CcStatementReconAdjustmentKind | null = null;
		if (c.componentType === "PURCHASE") {
			purchaseEventId = validateCcCanonicalUuid(
				c.purchaseEventId,
				`component ${componentNo} purchaseEventId`,
			);
			purchaseSplitRevisionId =
				c.purchaseSplitRevisionId != null
					? validateCcCanonicalUuid(
							c.purchaseSplitRevisionId,
							`component ${componentNo} purchaseSplitRevisionId`,
						)
					: null;
			if (c.adjustmentKind != null) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_INPUT",
					`component ${componentNo}: PURCHASE component must not carry an adjustmentKind`,
				);
			}
		} else {
			if (
				typeof c.adjustmentKind !== "string" ||
				!(CC_STATEMENT_RECON_ADJUSTMENT_KINDS as readonly string[]).includes(
					c.adjustmentKind,
				)
			) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_INPUT",
					`component ${componentNo}: ADJUSTMENT component requires adjustmentKind in ${CC_STATEMENT_RECON_ADJUSTMENT_KINDS.join(", ")}`,
				);
			}
			adjustmentKind = c.adjustmentKind;
			if (c.purchaseEventId != null || c.purchaseSplitRevisionId != null) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_INPUT",
					`component ${componentNo}: ADJUSTMENT component must not carry purchase references`,
				);
			}
		}

		return {
			componentNo,
			componentType: c.componentType,
			amountNormalized,
			amountCents,
			ownership: c.ownership,
			personId,
			purchaseEventId,
			purchaseSplitRevisionId,
			adjustmentKind,
			note: validateNote(c.note),
		};
	});
}

// ============================================================================
// Internal helpers
// ============================================================================

async function latestStatementRevision(
	tx: Database,
	statementId: string,
): Promise<typeof creditCardStatementRevisions.$inferSelect | undefined> {
	const [row] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(eq(creditCardStatementRevisions.statementId, statementId))
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);
	return row;
}

async function latestReconRevision(
	tx: Database,
	reconciliationId: string,
): Promise<
	typeof creditCardStatementReconciliationRevisions.$inferSelect | undefined
> {
	const [row] = await tx
		.select()
		.from(creditCardStatementReconciliationRevisions)
		.where(
			eq(
				creditCardStatementReconciliationRevisions.reconciliationId,
				reconciliationId,
			),
		)
		.orderBy(desc(creditCardStatementReconciliationRevisions.revisionNo))
		.limit(1);
	return row;
}

async function findReconRevisionByIdempotencyKey(
	tx: Database,
	userId: string,
	idempotencyKey: string,
): Promise<
	typeof creditCardStatementReconciliationRevisions.$inferSelect | undefined
> {
	const [row] = await tx
		.select()
		.from(creditCardStatementReconciliationRevisions)
		.where(
			and(
				eq(creditCardStatementReconciliationRevisions.userId, userId),
				eq(
					creditCardStatementReconciliationRevisions.idempotencyKey,
					idempotencyKey,
				),
			),
		)
		.limit(1);
	return row;
}

async function componentsFor(
	tx: Database,
	reconciliationRevisionId: string,
): Promise<ReconciliationComponentItem[]> {
	const rows = await tx
		.select()
		.from(creditCardStatementReconciliationComponents)
		.where(
			eq(
				creditCardStatementReconciliationComponents.reconciliationRevisionId,
				reconciliationRevisionId,
			),
		)
		.orderBy(creditCardStatementReconciliationComponents.componentNo);
	return rows.map((r) => ({
		componentNo: r.componentNo,
		componentType: r.componentType as CcStatementReconComponentType,
		amount: r.amount,
		ownership: r.ownership as CcStatementReconOwnership,
		personId: r.personId,
		purchaseEventId: r.purchaseEventId,
		purchaseSplitRevisionId: r.purchaseSplitRevisionId,
		adjustmentKind: r.adjustmentKind as CcStatementReconAdjustmentKind | null,
		note: r.note,
	}));
}

async function isSealed(
	tx: Database,
	reconciliationRevisionId: string,
): Promise<boolean> {
	const [row] = await tx
		.select({
			id: creditCardStatementReconciliationSeals.reconciliationRevisionId,
		})
		.from(creditCardStatementReconciliationSeals)
		.where(
			eq(
				creditCardStatementReconciliationSeals.reconciliationRevisionId,
				reconciliationRevisionId,
			),
		)
		.limit(1);
	return Boolean(row);
}

function toRevisionItem(
	row: typeof creditCardStatementReconciliationRevisions.$inferSelect,
	sealed: boolean,
): StatementReconciliationRevisionItem {
	return {
		reconciliationId: row.reconciliationId,
		revisionId: row.id,
		revisionNo: row.revisionNo,
		operation: row.operation as "CREATE" | "SUPERSEDE" | "VOID",
		statementRevisionId: row.statementRevisionId,
		reconciledStatementAmount: row.reconciledStatementAmount,
		componentCount: row.componentCount,
		sealed,
		occurredAt: row.occurredAt.toISOString(),
	};
}

function fpComponents(
	comps: NormalizedComponent[],
): ReconciliationComponentFingerprintInput[] {
	return comps.map((c) => ({
		componentNo: c.componentNo,
		componentType: c.componentType,
		amount: c.amountNormalized,
		ownership: c.ownership,
		personId: c.personId,
		purchaseEventId: c.purchaseEventId,
		purchaseSplitRevisionId: c.purchaseSplitRevisionId,
		adjustmentKind: c.adjustmentKind,
		note: c.note,
	}));
}

// ============================================================================
// reconcileStatement
// ============================================================================

export async function reconcileStatement(
	params: ReconcileStatementParams,
): Promise<ReconcileStatementResult> {
	const { db } = params;
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(
		params.statementId,
		"statementId",
	);
	const statementRevisionId = validateCcCanonicalUuid(
		params.statementRevisionId,
		"statementRevisionId",
	);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);
	const comps = normalizeComponents(params.components);
	const sumCents = comps.reduce((acc, c) => acc + c.amountCents, 0n);
	if (
		params.expectedRevisionNo !== undefined &&
		(!Number.isInteger(params.expectedRevisionNo) ||
			params.expectedRevisionNo < 1)
	) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer",
		);
	}

	return await db.transaction(async (txRaw) => {
		const tx = txRaw as unknown as Database;

		const [stmt] = await tx
			.select()
			.from(creditCardStatements)
			.where(
				and(
					eq(creditCardStatements.id, statementId),
					eq(creditCardStatements.userId, userId),
				),
			)
			.for("update")
			.limit(1);
		if (!stmt) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_NOT_FOUND",
				`statement "${statementId}" not found`,
			);
		}

		const stmtRev = await latestStatementRevision(tx, statementId);
		if (!stmtRev) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`statement "${statementId}" has no revisions`,
			);
		}
		if (stmtRev.id !== statementRevisionId) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
				`statementRevisionId "${statementRevisionId}" is not the statement's current latest revision "${stmtRev.id}"`,
			);
		}
		if (stmtRev.status === "VOID") {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_NOT_OPEN",
				`statement "${statementId}" latest revision is VOID; nothing to reconcile`,
			);
		}
		const stmtAmount = parsePositiveMoneyString(stmtRev.statementAmount);
		if (sumCents !== stmtAmount.cents) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_BALANCED",
				`reconciliation component sum ${sumCents} kurus does not equal statement_amount ${stmtAmount.cents} kurus`,
			);
		}

		// Anchor (find-or-create; unique on statement_id).
		let [anchor] = await tx
			.select()
			.from(creditCardStatementReconciliations)
			.where(eq(creditCardStatementReconciliations.statementId, statementId))
			.limit(1);
		if (!anchor) {
			const [created] = await tx
				.insert(creditCardStatementReconciliations)
				.values({
					userId,
					statementId,
					creditCardId: stmt.creditCardId,
				})
				.onConflictDoNothing({
					target: [creditCardStatementReconciliations.statementId],
				})
				.returning();
			anchor =
				created ??
				(
					await tx
						.select()
						.from(creditCardStatementReconciliations)
						.where(
							eq(creditCardStatementReconciliations.statementId, statementId),
						)
						.limit(1)
				)[0];
		}
		if (!anchor) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"failed to establish reconciliation anchor",
			);
		}

		// Historical idempotency.
		const existing = await findReconRevisionByIdempotencyKey(
			tx,
			userId,
			idempotencyKey,
		);
		const latestRev = await latestReconRevision(tx, anchor.id);

		let operation: "CREATE" | "SUPERSEDE";
		let previousRevisionId: string | null;
		let revisionNo: number;
		if (!latestRev) {
			operation = "CREATE";
			previousRevisionId = null;
			revisionNo = 1;
		} else {
			if (latestRev.operation === "VOID") {
				throw new CreditCardError(
					"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
					`statement "${statementId}" reconciliation is VOIDED (terminal); cannot supersede`,
				);
			}
			if (
				params.expectedRevisionNo !== undefined &&
				params.expectedRevisionNo !== latestRev.revisionNo
			) {
				throw new CreditCardError(
					"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
					`expected reconciliation revision ${params.expectedRevisionNo}, latest is ${latestRev.revisionNo}`,
				);
			}
			operation = "SUPERSEDE";
			previousRevisionId = latestRev.id;
			revisionNo = latestRev.revisionNo + 1;
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const fingerprint =
			await calculateStatementReconciliationRevisionFingerprint({
				userId,
				statementId,
				operation,
				revisionNo,
				previousRevisionId,
				statementRevisionId,
				reconciledStatementAmount: stmtAmount.normalized,
				occurredAt,
				components: fpComponents(comps),
			});

		if (existing) {
			if (existing.reconciliationFingerprint !== fingerprint) {
				throw new CreditCardError(
					"CREDIT_CARD_STATEMENT_RECONCILIATION_IDEMPOTENCY_CONFLICT",
					`idempotency key "${idempotencyKey}" was already used with a different reconciliation`,
				);
			}
			const sealed = await isSealed(tx, existing.id);
			return {
				revision: toRevisionItem(existing, sealed),
				components: await componentsFor(tx, existing.id),
				idempotentReplay: true,
			};
		}

		const [revRow] = await tx
			.insert(creditCardStatementReconciliationRevisions)
			.values({
				userId,
				reconciliationId: anchor.id,
				revisionNo,
				previousRevisionId,
				operation,
				statementRevisionId,
				reconciledStatementAmount: stmtAmount.normalized,
				componentCount: comps.length,
				idempotencyKey,
				reconciliationFingerprint: fingerprint,
				occurredAt,
			})
			.returning();
		if (!revRow) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"failed to insert reconciliation revision",
			);
		}

		for (const c of comps) {
			await tx.insert(creditCardStatementReconciliationComponents).values({
				reconciliationRevisionId: revRow.id,
				componentNo: c.componentNo,
				componentType: c.componentType,
				amount: c.amountNormalized,
				ownership: c.ownership,
				personId: c.personId,
				purchaseEventId: c.purchaseEventId,
				purchaseSplitRevisionId: c.purchaseSplitRevisionId,
				adjustmentKind: c.adjustmentKind,
				note: c.note,
			});
		}

		await tx.insert(creditCardStatementReconciliationSeals).values({
			reconciliationRevisionId: revRow.id,
		});

		return {
			revision: toRevisionItem(revRow, true),
			components: await componentsFor(tx, revRow.id),
			idempotentReplay: false,
		};
	});
}

// ============================================================================
// voidStatementReconciliation
// ============================================================================

export async function voidStatementReconciliation(
	params: VoidStatementReconciliationParams,
): Promise<ReconcileStatementResult> {
	const { db, expectedRevisionNo } = params;
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(
		params.statementId,
		"statementId",
	);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);
	if (!Number.isInteger(expectedRevisionNo) || expectedRevisionNo < 1) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer",
		);
	}

	return await db.transaction(async (txRaw) => {
		const tx = txRaw as unknown as Database;
		const [anchor] = await tx
			.select()
			.from(creditCardStatementReconciliations)
			.where(
				and(
					eq(creditCardStatementReconciliations.statementId, statementId),
					eq(creditCardStatementReconciliations.userId, userId),
				),
			)
			.for("update")
			.limit(1);
		if (!anchor) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_FOUND",
				`statement "${statementId}" has no reconciliation to void`,
			);
		}
		const latestRev = await latestReconRevision(tx, anchor.id);
		if (!latestRev) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_FOUND",
				`statement "${statementId}" has no reconciliation revisions`,
			);
		}

		const existing = await findReconRevisionByIdempotencyKey(
			tx,
			userId,
			idempotencyKey,
		);
		const occurredAt = explicitOccurredAt ?? new Date();
		const fingerprint =
			await calculateStatementReconciliationRevisionFingerprint({
				userId,
				statementId,
				operation: "VOID",
				revisionNo: latestRev.revisionNo + 1,
				previousRevisionId: latestRev.id,
				statementRevisionId: latestRev.statementRevisionId,
				reconciledStatementAmount: latestRev.reconciledStatementAmount,
				occurredAt,
				components: [],
			});
		if (existing) {
			if (existing.reconciliationFingerprint !== fingerprint) {
				throw new CreditCardError(
					"CREDIT_CARD_STATEMENT_RECONCILIATION_IDEMPOTENCY_CONFLICT",
					`idempotency key "${idempotencyKey}" was already used with a different reconciliation`,
				);
			}
			return {
				revision: toRevisionItem(existing, false),
				components: [],
				idempotentReplay: true,
			};
		}

		if (latestRev.operation === "VOID") {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
				`statement "${statementId}" reconciliation is already VOIDED`,
			);
		}
		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
				`expected reconciliation revision ${expectedRevisionNo}, latest is ${latestRev.revisionNo}`,
			);
		}

		const [revRow] = await tx
			.insert(creditCardStatementReconciliationRevisions)
			.values({
				userId,
				reconciliationId: anchor.id,
				revisionNo: latestRev.revisionNo + 1,
				previousRevisionId: latestRev.id,
				operation: "VOID",
				statementRevisionId: latestRev.statementRevisionId,
				reconciledStatementAmount: latestRev.reconciledStatementAmount,
				componentCount: 0,
				idempotencyKey,
				reconciliationFingerprint: fingerprint,
				occurredAt,
			})
			.returning();
		if (!revRow) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"failed to insert VOID reconciliation revision",
			);
		}
		return {
			revision: toRevisionItem(revRow, false),
			components: [],
			idempotentReplay: false,
		};
	});
}

// ============================================================================
// getStatementReconciliation
// ============================================================================

export async function getStatementReconciliation(params: {
	db: Database;
	userId: string;
	statementId: string;
}): Promise<StatementReconciliationView> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(
		params.statementId,
		"statementId",
	);
	const db = params.db;

	const base: StatementReconciliationView = {
		statementId,
		status: "NONE",
		revisionNo: null,
		statementRevisionId: null,
		reconciledStatementAmount: null,
		components: [],
		personalCents: 0n,
		externalByPerson: new Map(),
	};

	const [anchor] = await db
		.select()
		.from(creditCardStatementReconciliations)
		.where(
			and(
				eq(creditCardStatementReconciliations.statementId, statementId),
				eq(creditCardStatementReconciliations.userId, userId),
			),
		)
		.limit(1);
	if (!anchor) return base;

	const latestRev = await latestReconRevision(db, anchor.id);
	if (!latestRev) return base;

	base.revisionNo = latestRev.revisionNo;
	base.statementRevisionId = latestRev.statementRevisionId;
	base.reconciledStatementAmount = latestRev.reconciledStatementAmount;

	if (latestRev.operation === "VOID") {
		return { ...base, status: "VOIDED" };
	}
	if (!(await isSealed(db, latestRev.id))) {
		return { ...base, status: "UNSEALED" };
	}

	// Freshness: the sealed reconciliation must match the statement's CURRENT
	// latest revision id AND amount.
	const stmtRev = await latestStatementRevision(db, statementId);
	if (
		!stmtRev ||
		stmtRev.id !== latestRev.statementRevisionId ||
		parsePositiveMoneyString(stmtRev.statementAmount).cents !==
			parsePositiveMoneyString(latestRev.reconciledStatementAmount).cents
	) {
		return { ...base, status: "STALE" };
	}

	const components = await componentsFor(db, latestRev.id);
	let personalCents = 0n;
	const externalByPerson = new Map<string, bigint>();
	for (const c of components) {
		const cents = parsePositiveMoneyString(c.amount).cents;
		if (c.ownership === "PERSONAL") {
			personalCents += cents;
		} else if (c.personId) {
			externalByPerson.set(
				c.personId,
				(externalByPerson.get(c.personId) ?? 0n) + cents,
			);
		}
	}

	return {
		...base,
		status: "RECONCILED",
		components,
		personalCents,
		externalByPerson,
	};
}

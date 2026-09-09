import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { effectiveRevisionAsOf } from "../db/effective-revision";
import { creditCardLiabilityEventRevisions } from "../db/schema/credit-card-ledger";
import {
	creditCardPurchaseSplitRevisionItems,
	creditCardPurchaseSplitRevisionSeals,
	creditCardPurchaseSplitRevisions,
	creditCardPurchaseSplits,
} from "../db/schema/credit-card-splits";
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
import {
	parseAggregateMoneyString,
	parsePositiveMoneyString,
} from "../ledger/money";
import { validateCcCanonicalUuid } from "./calendar";
import { CreditCardError } from "./errors";
import { resolveAuthoritativePurchaseSplitAsOf } from "./purchase-split-read";
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
	/** MUST be the statement's current latest (non-VOID) revision id. */
	statementRevisionId: string;
	components: ReconciliationComponentInput[];
	idempotencyKey: string;
	/**
	 * OCC. Omit for the first reconciliation (CREATE); REQUIRED to supersede an
	 * existing one and must equal the current latest reconciliation revision no.
	 */
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
	| "VOIDED" // latest reconciliation revision is a terminal VOID
	| "STATEMENT_VOID" // the statement itself is VOID -- not usable
	| "STALE" // sealed, but the statement amount changed, or the referenced
	// purchase/split evidence has since become VOID / superseded / incompatible
	| "RECONCILED"; // sealed and current

export interface StatementReconciliationView {
	statementId: string;
	status: StatementReconciliationStatus;
	revisionNo: number | null;
	statementRevisionId: string | null;
	reconciledStatementAmount: string | null;
	/** Set when status is STALE / STATEMENT_VOID -- why it is not usable. */
	staleReason: string | null;
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
// Purchase / split integrity (section 6)
// ============================================================================

interface ActiveSplitInfo {
	splitRevisionId: string;
	userShareCents: bigint;
	sealed: boolean;
	participantPersonIds: Set<string>;
}

/**
 * The authoritative ACTIVE split for a purchase = its split anchor's latest
 * non-VOID revision. Returns null when the purchase has no split, or its latest
 * split revision is VOID (i.e. the purchase is currently unsplit / 100% user).
 */
async function activeSplitForPurchase(
	db: Database,
	purchaseEventId: string,
): Promise<ActiveSplitInfo | null> {
	const [split] = await db
		.select({ id: creditCardPurchaseSplits.id })
		.from(creditCardPurchaseSplits)
		.where(eq(creditCardPurchaseSplits.purchaseEventId, purchaseEventId))
		.limit(1);
	if (!split) return null;
	const [rev] = await db
		.select({
			id: creditCardPurchaseSplitRevisions.id,
			operation: creditCardPurchaseSplitRevisions.operation,
			userShare: creditCardPurchaseSplitRevisions.userShareAmount,
		})
		.from(creditCardPurchaseSplitRevisions)
		.where(eq(creditCardPurchaseSplitRevisions.splitId, split.id))
		.orderBy(desc(creditCardPurchaseSplitRevisions.revisionNo))
		.limit(1);
	if (!rev || rev.operation === "VOID") return null;
	const [seal] = await db
		.select({
			id: creditCardPurchaseSplitRevisionSeals.splitRevisionId,
		})
		.from(creditCardPurchaseSplitRevisionSeals)
		.where(eq(creditCardPurchaseSplitRevisionSeals.splitRevisionId, rev.id))
		.limit(1);
	const items = await db
		.select({ personId: creditCardPurchaseSplitRevisionItems.personId })
		.from(creditCardPurchaseSplitRevisionItems)
		.where(eq(creditCardPurchaseSplitRevisionItems.splitRevisionId, rev.id));
	return {
		splitRevisionId: rev.id,
		userShareCents: parseAggregateMoneyString(rev.userShare).cents,
		sealed: Boolean(seal),
		participantPersonIds: new Set(items.map((i) => i.personId)),
	};
}

/** Write-time: a new PURCHASE component must not contradict split truth. */
async function assertPurchaseComponentSplitConsistency(
	db: Database,
	c: NormalizedComponent,
): Promise<void> {
	if (c.componentType !== "PURCHASE" || !c.purchaseEventId) return;
	const active = await activeSplitForPurchase(db, c.purchaseEventId);
	const fail = (msg: string): never => {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
			`component ${c.componentNo}: ${msg}`,
		);
	};
	if (!active) {
		if (c.ownership !== "PERSONAL") {
			fail(
				`purchase ${c.purchaseEventId} has no active split; PURCHASE component ownership must be PERSONAL`,
			);
		}
		if (c.purchaseSplitRevisionId) {
			fail(
				`purchase ${c.purchaseEventId} has no active split; purchaseSplitRevisionId must be null`,
			);
		}
		return;
	}
	if (c.purchaseSplitRevisionId !== active.splitRevisionId) {
		fail(
			`purchaseSplitRevisionId must be the active split revision "${active.splitRevisionId}" for purchase ${c.purchaseEventId}`,
		);
	}
	if (!active.sealed) {
		fail(`active split revision "${active.splitRevisionId}" is not sealed`);
	}
	if (c.ownership === "EXTERNAL_PERSON") {
		if (!c.personId || !active.participantPersonIds.has(c.personId)) {
			fail(
				`personId ${c.personId} is not a participant of split revision "${active.splitRevisionId}"`,
			);
		}
	} else if (active.userShareCents <= 0n) {
		fail(
			`split revision "${active.splitRevisionId}" has zero user share; PERSONAL ownership is incompatible`,
		);
	}
}

/** Read-time freshness: why a stored PURCHASE component is no longer trustworthy. */
async function purchaseComponentStaleReason(
	db: Database,
	item: ReconciliationComponentItem,
): Promise<string | null> {
	if (item.componentType !== "PURCHASE" || !item.purchaseEventId) return null;
	const [ev] = await db
		.select({ operation: creditCardLiabilityEventRevisions.operation })
		.from(creditCardLiabilityEventRevisions)
		.where(eq(creditCardLiabilityEventRevisions.eventId, item.purchaseEventId))
		.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
		.limit(1);
	if (!ev) return `purchase event ${item.purchaseEventId} has no revisions`;
	if (ev.operation === "VOID") {
		return `purchase event ${item.purchaseEventId} is now VOID`;
	}
	const active = await activeSplitForPurchase(db, item.purchaseEventId);
	if (!active) {
		if (item.purchaseSplitRevisionId) {
			return `purchase ${item.purchaseEventId} no longer has an active split`;
		}
		if (item.ownership !== "PERSONAL") {
			return `purchase ${item.purchaseEventId} is now unsplit; ownership ${item.ownership} incompatible`;
		}
		return null;
	}
	if (item.purchaseSplitRevisionId !== active.splitRevisionId) {
		return `purchase ${item.purchaseEventId} split evidence superseded (${item.purchaseSplitRevisionId} -> ${active.splitRevisionId})`;
	}
	if (!active.sealed) {
		return `active split revision ${active.splitRevisionId} is not sealed`;
	}
	if (
		item.ownership === "EXTERNAL_PERSON" &&
		(!item.personId || !active.participantPersonIds.has(item.personId))
	) {
		return `personId ${item.personId} is no longer a participant of split ${active.splitRevisionId}`;
	}
	if (item.ownership === "PERSONAL" && active.userShareCents <= 0n) {
		return `split ${active.splitRevisionId} user share is now zero; PERSONAL ownership incompatible`;
	}
	return null;
}

// ============================================================================
// AS-OF (business-effective) read path -- for historical payment-event reports
// ============================================================================

/** Why a stored PURCHASE component was not trustworthy AT `asOf` (a future VOID /
 * supersede must NOT retroactively stale a historical reconciliation). Uses the
 * ONE authoritative as-of split reader -- an inconsistent / unsealed effective
 * split makes the component (and the reconciliation) STALE / unusable. */
async function purchaseComponentStaleReasonAsOf(
	db: Database,
	userId: string,
	item: ReconciliationComponentItem,
	asOf: Date,
): Promise<string | null> {
	if (item.componentType !== "PURCHASE" || !item.purchaseEventId) return null;
	const evRevs = await db
		.select({
			revisionNo: creditCardLiabilityEventRevisions.revisionNo,
			operation: creditCardLiabilityEventRevisions.operation,
			occurredAt: creditCardLiabilityEventRevisions.occurredAt,
		})
		.from(creditCardLiabilityEventRevisions)
		.where(eq(creditCardLiabilityEventRevisions.eventId, item.purchaseEventId));
	const ev = effectiveRevisionAsOf(evRevs, asOf);
	if (!ev) {
		return `purchase event ${item.purchaseEventId} had no revision effective at ${asOf.toISOString()}`;
	}
	if (ev.operation === "VOID") {
		return `purchase event ${item.purchaseEventId} was VOID as of ${asOf.toISOString()}`;
	}

	const split = await resolveAuthoritativePurchaseSplitAsOf({
		db,
		userId,
		purchaseEventId: item.purchaseEventId,
		asOf,
	});
	if (split.kind === "NO_SPLIT" || split.kind === "VOID_SPLIT") {
		if (item.purchaseSplitRevisionId) {
			return `purchase ${item.purchaseEventId} had no active split as of the checkpoint`;
		}
		if (item.ownership !== "PERSONAL") {
			return `purchase ${item.purchaseEventId} was unsplit as of the checkpoint; ownership ${item.ownership} incompatible`;
		}
		return null;
	}
	if (split.kind === "UNRESOLVED") {
		return `purchase ${item.purchaseEventId} split evidence is not authoritative as of the checkpoint (${split.reason})`;
	}
	// ACTIVE
	if (item.purchaseSplitRevisionId !== split.splitRevisionId) {
		return `purchase ${item.purchaseEventId} split evidence not effective as of the checkpoint (${item.purchaseSplitRevisionId} -> ${split.splitRevisionId})`;
	}
	if (
		item.ownership === "EXTERNAL_PERSON" &&
		(!item.personId ||
			!split.participants.some((p) => p.personId === item.personId))
	) {
		return `personId ${item.personId} was not a participant of split ${split.splitRevisionId} as of the checkpoint`;
	}
	if (item.ownership === "PERSONAL" && split.userShareCents <= 0n) {
		return `split ${split.splitRevisionId} user share was zero as of the checkpoint`;
	}
	return null;
}

async function reconRevisionAsOf(
	db: Database,
	reconciliationId: string,
	asOf: Date,
): Promise<
	typeof creditCardStatementReconciliationRevisions.$inferSelect | undefined
> {
	const rows = await db
		.select()
		.from(creditCardStatementReconciliationRevisions)
		.where(
			eq(
				creditCardStatementReconciliationRevisions.reconciliationId,
				reconciliationId,
			),
		);
	return effectiveRevisionAsOf(rows, asOf);
}

async function statementRevisionAsOf(
	db: Database,
	statementId: string,
	asOf: Date,
): Promise<typeof creditCardStatementRevisions.$inferSelect | undefined> {
	const rows = await db
		.select()
		.from(creditCardStatementRevisions)
		.where(eq(creditCardStatementRevisions.statementId, statementId));
	return effectiveRevisionAsOf(rows, asOf);
}

// ============================================================================
// Race-safe idempotency replay (section 5)
// ============================================================================

interface ReplayCtx {
	userId: string;
	statementId: string;
	fingerprintComponents: ReconciliationComponentFingerprintInput[];
	explicitOccurredAt: Date | undefined;
	idempotencyKey: string;
}

/**
 * Fail-closed replay of an already-stored reconciliation revision found by
 * `(userId, idempotencyKey)`. The candidate fingerprint is rebuilt from the
 * STORED positional fields (so a PAY lifecycle transition can never turn an
 * exact retry into a false conflict) plus the incoming components and the
 * effective occurredAt (STORED occurredAt when the caller omitted it).
 */
async function replayReconcile(
	db: Database,
	existing: typeof creditCardStatementReconciliationRevisions.$inferSelect,
	ctx: ReplayCtx,
): Promise<ReconcileStatementResult> {
	const candidateFp = await calculateStatementReconciliationRevisionFingerprint(
		{
			userId: ctx.userId,
			statementId: ctx.statementId,
			operation: existing.operation as "CREATE" | "SUPERSEDE" | "VOID",
			revisionNo: existing.revisionNo,
			previousRevisionId: existing.previousRevisionId,
			statementRevisionId: existing.statementRevisionId,
			reconciledStatementAmount: existing.reconciledStatementAmount,
			occurredAt: ctx.explicitOccurredAt ?? existing.occurredAt,
			components: ctx.fingerprintComponents,
		},
	);
	if (candidateFp !== existing.reconciliationFingerprint) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_RECONCILIATION_IDEMPOTENCY_CONFLICT",
			`idempotency key "${ctx.idempotencyKey}" was already used with a different reconciliation`,
		);
	}
	const sealed = await isSealed(db, existing.id);
	return {
		revision: toRevisionItem(existing, sealed),
		components: await componentsFor(db, existing.id),
		idempotentReplay: true,
	};
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
	const fpComps = fpComponents(comps);
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

	const replayCtx: ReplayCtx = {
		userId,
		statementId,
		fingerprintComponents: fpComps,
		explicitOccurredAt,
		idempotencyKey,
	};

	// FAST historical idempotency -- BEFORE any mutable latest-state validation,
	// so an exact retry (incl. after a PAY lifecycle transition, and with
	// occurredAt omitted) is a replay, never a false conflict.
	const fast = await findReconRevisionByIdempotencyKey(
		db,
		userId,
		idempotencyKey,
	);
	if (fast) return replayReconcile(db, fast, replayCtx);

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

		// SECOND idempotency lookup, now holding the statement lock -- a racer
		// that committed after the fast path is visible here.
		const raced = await findReconRevisionByIdempotencyKey(
			tx,
			userId,
			idempotencyKey,
		);
		if (raced) return replayReconcile(tx, raced, replayCtx);

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

		// section 6 -- PURCHASE components must agree with authoritative split truth.
		for (const c of comps) {
			await assertPurchaseComponentSplitConsistency(tx, c);
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

		const latestRev = await latestReconRevision(tx, anchor.id);

		let operation: "CREATE" | "SUPERSEDE";
		let previousRevisionId: string | null;
		let revisionNo: number;
		if (!latestRev) {
			if (params.expectedRevisionNo !== undefined) {
				throw new CreditCardError(
					"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
					`statement "${statementId}" has no reconciliation to supersede`,
				);
			}
			operation = "CREATE";
			previousRevisionId = null;
			revisionNo = 1;
		} else if (latestRev.operation === "VOID") {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
				`statement "${statementId}" reconciliation is VOIDED (terminal); cannot supersede`,
			);
		} else {
			if (params.expectedRevisionNo === undefined) {
				throw new CreditCardError(
					"CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT",
					`statement "${statementId}" is already reconciled (revision ${latestRev.revisionNo}); pass expectedRevisionNo to supersede`,
				);
			}
			if (params.expectedRevisionNo !== latestRev.revisionNo) {
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
				components: fpComps,
			});

		// Race-safe insert: a cross-statement same-key writer is absorbed by the
		// (user_id, idempotency_key) unique index, never a raw 23505.
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
			.onConflictDoNothing({
				target: [
					creditCardStatementReconciliationRevisions.userId,
					creditCardStatementReconciliationRevisions.idempotencyKey,
				],
			})
			.returning();
		if (!revRow) {
			const afterConflict = await findReconRevisionByIdempotencyKey(
				tx,
				userId,
				idempotencyKey,
			);
			if (!afterConflict) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					"reconciliation idempotency key conflicted but no row is visible",
				);
			}
			return replayReconcile(tx, afterConflict, replayCtx);
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

	const replayCtx: ReplayCtx = {
		userId,
		statementId,
		fingerprintComponents: [],
		explicitOccurredAt,
		idempotencyKey,
	};

	const fast = await findReconRevisionByIdempotencyKey(
		db,
		userId,
		idempotencyKey,
	);
	if (fast) return replayReconcile(db, fast, replayCtx);

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

		const raced = await findReconRevisionByIdempotencyKey(
			tx,
			userId,
			idempotencyKey,
		);
		if (raced) return replayReconcile(tx, raced, replayCtx);

		const latestRev = await latestReconRevision(tx, anchor.id);
		if (!latestRev) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_FOUND",
				`statement "${statementId}" has no reconciliation revisions`,
			);
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
			.onConflictDoNothing({
				target: [
					creditCardStatementReconciliationRevisions.userId,
					creditCardStatementReconciliationRevisions.idempotencyKey,
				],
			})
			.returning();
		if (!revRow) {
			const afterConflict = await findReconRevisionByIdempotencyKey(
				tx,
				userId,
				idempotencyKey,
			);
			if (!afterConflict) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					"reconciliation idempotency key conflicted but no row is visible",
				);
			}
			return replayReconcile(tx, afterConflict, replayCtx);
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
		staleReason: null,
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

	// Freshness (section 1): a status-only lifecycle change (PAY / compatible
	// REOPEN) creates a new statement revision but MUST NOT stale the
	// reconciliation. Staleness = the statement is VOID, or the economic
	// statement amount it decomposes has changed.
	const stmtRev = await latestStatementRevision(db, statementId);
	if (!stmtRev) {
		return {
			...base,
			status: "STALE",
			staleReason: "statement has no revisions",
		};
	}
	if (stmtRev.status === "VOID") {
		return {
			...base,
			status: "STATEMENT_VOID",
			staleReason: "the statement itself is VOID",
		};
	}
	if (
		parsePositiveMoneyString(stmtRev.statementAmount).cents !==
		parsePositiveMoneyString(latestRev.reconciledStatementAmount).cents
	) {
		return {
			...base,
			status: "STALE",
			staleReason: `statement amount changed (${latestRev.reconciledStatementAmount} -> ${stmtRev.statementAmount}); supersede the reconciliation`,
		};
	}

	const components = await componentsFor(db, latestRev.id);

	// Read-time evidence freshness (section 6): if a referenced purchase/split
	// has since become VOID / superseded / incompatible, do NOT keep summing the
	// old components -- report STALE.
	for (const c of components) {
		const reason = await purchaseComponentStaleReason(db, c);
		if (reason) {
			return { ...base, status: "STALE", staleReason: reason };
		}
	}

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

/**
 * AS-OF twin of `getStatementReconciliation`: the reconciliation STATE that was
 * business-effective at `asOf` (highest revisionNo with occurredAt <= asOf).
 *
 * Never uses the current/latest reconciliation merely because the amount is
 * unchanged; a SUPERSEDE / VOID authored after `asOf` cannot rewrite a
 * historical checkpoint. The statement amount is validated against the
 * statement revision effective at `asOf`, and referenced purchase / split
 * evidence is checked as it stood at `asOf`. Returns the same NONE / VOIDED /
 * UNSEALED / STALE / STATEMENT_VOID / RECONCILED view. Does not mutate history.
 */
export async function getStatementReconciliationAsOf(params: {
	db: Database;
	userId: string;
	statementId: string;
	asOf: Date;
}): Promise<StatementReconciliationView> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(
		params.statementId,
		"statementId",
	);
	const { db } = params;
	if (!(params.asOf instanceof Date) || Number.isNaN(params.asOf.getTime())) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"asOf must be a valid Date object",
		);
	}
	const asOf = params.asOf;

	const base: StatementReconciliationView = {
		statementId,
		status: "NONE",
		revisionNo: null,
		statementRevisionId: null,
		reconciledStatementAmount: null,
		staleReason: null,
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

	const rev = await reconRevisionAsOf(db, anchor.id, asOf);
	if (!rev) return base; // no reconciliation was effective yet at asOf

	base.revisionNo = rev.revisionNo;
	base.statementRevisionId = rev.statementRevisionId;
	base.reconciledStatementAmount = rev.reconciledStatementAmount;

	if (rev.operation === "VOID") {
		return { ...base, status: "VOIDED" };
	}
	if (!(await isSealed(db, rev.id))) {
		return { ...base, status: "UNSEALED" };
	}

	const stmtRev = await statementRevisionAsOf(db, statementId, asOf);
	if (!stmtRev) {
		return {
			...base,
			status: "STALE",
			staleReason: "statement had no revision effective at the checkpoint",
		};
	}
	if (stmtRev.status === "VOID") {
		return {
			...base,
			status: "STATEMENT_VOID",
			staleReason: "the statement was VOID as of the checkpoint",
		};
	}
	if (
		parsePositiveMoneyString(stmtRev.statementAmount).cents !==
		parsePositiveMoneyString(rev.reconciledStatementAmount).cents
	) {
		return {
			...base,
			status: "STALE",
			staleReason: `statement amount as of the checkpoint (${stmtRev.statementAmount}) does not match the reconciled amount (${rev.reconciledStatementAmount})`,
		};
	}

	const components = await componentsFor(db, rev.id);
	for (const c of components) {
		const reason = await purchaseComponentStaleReasonAsOf(db, userId, c, asOf);
		if (reason) {
			return { ...base, status: "STALE", staleReason: reason };
		}
	}

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

import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	pushSubscriptionRevisions,
	pushSubscriptions,
} from "../db/schema/notifications";
import {
	runNotificationReadTransaction,
	runNotificationTransaction,
} from "./boundary";
import {
	assertP256dhOnCurve,
	computeEndpointHash,
	validateNotificationAuth,
	validateNotificationCanonicalUuid,
	validateNotificationIdempotencyKey,
	validateNotificationOccurredAt,
	validateNotificationOptionalExpirationTime,
	validateNotificationOptionalSubscriptionStatus,
	validateNotificationOptionalText,
	validateNotificationP256dh,
	validateNotificationPushEndpoint,
} from "./calendar";
import { NotificationError } from "./errors";
import {
	calculatePushSubscriptionDisableFingerprint,
	calculatePushSubscriptionRegisterFingerprint,
} from "./fingerprint";

type PushSubscriptionStatus = "ACTIVE" | "DISABLED";
type PushSubscriptionOperation =
	| "REGISTER"
	| "REFRESH"
	| "DISABLE"
	| "REACTIVATE";

export interface PushSubscriptionReadModel {
	subscriptionId: string;
	userId: string;
	status: PushSubscriptionStatus;
	revisionNo: number;
	endpoint: string;
	p256dh: string;
	auth: string;
	expirationTime: Date | null;
	userAgent: string | null;
	createdAt: Date;
}

function toReadModel(
	subscriptionId: string,
	userId: string,
	revision: typeof pushSubscriptionRevisions.$inferSelect,
	createdAt: Date,
): PushSubscriptionReadModel {
	return {
		subscriptionId,
		userId,
		status: revision.status as PushSubscriptionStatus,
		revisionNo: revision.revisionNo,
		endpoint: revision.endpoint,
		p256dh: revision.p256dh,
		auth: revision.auth,
		expirationTime: revision.expirationTime,
		userAgent: revision.userAgent,
		createdAt,
	};
}

async function findLatestRevisionInTransaction(
	tx: DatabaseTransaction,
	subscriptionId: string,
): Promise<typeof pushSubscriptionRevisions.$inferSelect | undefined> {
	const [row] = await tx
		.select()
		.from(pushSubscriptionRevisions)
		.where(eq(pushSubscriptionRevisions.subscriptionId, subscriptionId))
		.orderBy(desc(pushSubscriptionRevisions.revisionNo))
		.limit(1);
	return row;
}

async function findRevisionByIdempotencyKeyInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	idempotencyKey: string,
): Promise<typeof pushSubscriptionRevisions.$inferSelect | undefined> {
	const [row] = await tx
		.select()
		.from(pushSubscriptionRevisions)
		.where(
			and(
				eq(pushSubscriptionRevisions.userId, userId),
				eq(pushSubscriptionRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	return row;
}

// ============================================================================
// REGISTER / REFRESH / REACTIVATE
// ============================================================================

export interface RegisterPushSubscriptionInTransactionArgs {
	userId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	expirationTime: Date | null;
	userAgent: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export async function registerPushSubscriptionInTransaction(
	tx: DatabaseTransaction,
	args: RegisterPushSubscriptionInTransactionArgs,
): Promise<{
	subscription: PushSubscriptionReadModel;
	idempotentReplay: boolean;
}> {
	const endpointHash = await computeEndpointHash(args.endpoint);

	const tryReplay = async (
		existingRev: typeof pushSubscriptionRevisions.$inferSelect,
		expectedOperations: PushSubscriptionOperation[],
	) => {
		if (
			!expectedOperations.includes(
				existingRev.operation as PushSubscriptionOperation,
			)
		) {
			throw new NotificationError(
				"NOTIFICATION_IDEMPOTENCY_CONFLICT",
				"Idempotency key was already used for a different push subscription operation",
			);
		}
		const candidateFingerprint =
			await calculatePushSubscriptionRegisterFingerprint({
				userId: args.userId,
				endpointHash,
				operation: existingRev.operation as
					| "REGISTER"
					| "REFRESH"
					| "REACTIVATE",
				endpoint: args.endpoint,
				p256dh: args.p256dh,
				auth: args.auth,
				expirationTime: args.expirationTime,
				userAgent: args.userAgent,
				occurredAt: args.occurredAt,
			});
		if (candidateFingerprint !== existingRev.revisionFingerprint) {
			throw new NotificationError(
				"NOTIFICATION_IDEMPOTENCY_CONFLICT",
				"Idempotency key reused with a different push subscription payload",
			);
		}
		const [anchor] = await tx
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.id, existingRev.subscriptionId))
			.limit(1);
		if (!anchor) {
			throw new NotificationError(
				"NOTIFICATION_INVALID_STATE",
				"Failed to load replayed push subscription anchor",
			);
		}
		return {
			subscription: toReadModel(
				anchor.id,
				anchor.userId,
				existingRev,
				anchor.createdAt,
			),
			idempotentReplay: true as const,
		};
	};

	const earlyRev = await findRevisionByIdempotencyKeyInTransaction(
		tx,
		args.userId,
		args.idempotencyKey,
	);
	if (earlyRev) {
		return tryReplay(earlyRev, ["REGISTER", "REFRESH", "REACTIVATE"]);
	}

	const [existingAnchor] = await tx
		.select()
		.from(pushSubscriptions)
		.where(
			and(
				eq(pushSubscriptions.userId, args.userId),
				eq(pushSubscriptions.endpointHash, endpointHash),
			),
		)
		.limit(1);

	if (!existingAnchor) {
		// Re-check idempotency under the (implicit) insert-time lock to close
		// the early-check race window, then create a brand-new anchor.
		const secondRev = await findRevisionByIdempotencyKeyInTransaction(
			tx,
			args.userId,
			args.idempotencyKey,
		);
		if (secondRev)
			return tryReplay(secondRev, ["REGISTER", "REFRESH", "REACTIVATE"]);

		const [insertedAnchor] = await tx
			.insert(pushSubscriptions)
			.values({ userId: args.userId, endpointHash })
			.onConflictDoNothing()
			.returning();

		const anchor =
			insertedAnchor ??
			(
				await tx
					.select()
					.from(pushSubscriptions)
					.where(
						and(
							eq(pushSubscriptions.userId, args.userId),
							eq(pushSubscriptions.endpointHash, endpointHash),
						),
					)
					.limit(1)
			)[0];
		if (!anchor) {
			throw new NotificationError(
				"NOTIFICATION_INVALID_STATE",
				"Failed to create or resolve push subscription anchor",
			);
		}

		// Another concurrent caller may have won the race and already
		// inserted revision #1 for this anchor.
		const raced = await findLatestRevisionInTransaction(tx, anchor.id);
		if (raced) {
			const thirdRev = await findRevisionByIdempotencyKeyInTransaction(
				tx,
				args.userId,
				args.idempotencyKey,
			);
			if (thirdRev)
				return tryReplay(thirdRev, ["REGISTER", "REFRESH", "REACTIVATE"]);
			return registerAgainstExistingAnchor(tx, anchor.id, args, endpointHash);
		}

		const fingerprint = await calculatePushSubscriptionRegisterFingerprint({
			userId: args.userId,
			endpointHash,
			operation: "REGISTER",
			endpoint: args.endpoint,
			p256dh: args.p256dh,
			auth: args.auth,
			expirationTime: args.expirationTime,
			userAgent: args.userAgent,
			occurredAt: args.occurredAt,
		});

		const [insertedRev] = await tx
			.insert(pushSubscriptionRevisions)
			.values({
				userId: args.userId,
				subscriptionId: anchor.id,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "REGISTER",
				status: "ACTIVE",
				endpoint: args.endpoint,
				p256dh: args.p256dh,
				auth: args.auth,
				expirationTime: args.expirationTime,
				userAgent: args.userAgent,
				disableReason: null,
				occurredAt: args.occurredAt,
				idempotencyKey: args.idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();
		if (!insertedRev) {
			throw new NotificationError(
				"NOTIFICATION_INVALID_STATE",
				"Failed to create push subscription revision #1",
			);
		}
		return {
			subscription: toReadModel(
				anchor.id,
				anchor.userId,
				insertedRev,
				anchor.createdAt,
			),
			idempotentReplay: false,
		};
	}

	const secondRev = await findRevisionByIdempotencyKeyInTransaction(
		tx,
		args.userId,
		args.idempotencyKey,
	);
	if (secondRev)
		return tryReplay(secondRev, ["REGISTER", "REFRESH", "REACTIVATE"]);

	return registerAgainstExistingAnchor(
		tx,
		existingAnchor.id,
		args,
		endpointHash,
	);
}

async function registerAgainstExistingAnchor(
	tx: DatabaseTransaction,
	subscriptionId: string,
	args: RegisterPushSubscriptionInTransactionArgs,
	endpointHash: string,
): Promise<{
	subscription: PushSubscriptionReadModel;
	idempotentReplay: boolean;
}> {
	const latest = await findLatestRevisionInTransaction(tx, subscriptionId);
	if (!latest) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_STATE",
			"Push subscription anchor has no revisions",
		);
	}
	const operation: "REFRESH" | "REACTIVATE" =
		latest.status === "ACTIVE" ? "REFRESH" : "REACTIVATE";

	const fingerprint = await calculatePushSubscriptionRegisterFingerprint({
		userId: args.userId,
		endpointHash,
		operation,
		endpoint: args.endpoint,
		p256dh: args.p256dh,
		auth: args.auth,
		expirationTime: args.expirationTime,
		userAgent: args.userAgent,
		occurredAt: args.occurredAt,
	});

	const [insertedRev] = await tx
		.insert(pushSubscriptionRevisions)
		.values({
			userId: args.userId,
			subscriptionId,
			revisionNo: latest.revisionNo + 1,
			previousRevisionId: latest.id,
			operation,
			status: "ACTIVE",
			endpoint: args.endpoint,
			p256dh: args.p256dh,
			auth: args.auth,
			expirationTime: args.expirationTime,
			userAgent: args.userAgent,
			disableReason: null,
			occurredAt: args.occurredAt,
			idempotencyKey: args.idempotencyKey,
			revisionFingerprint: fingerprint,
		})
		.returning();
	if (!insertedRev) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_STATE",
			`Failed to create push subscription ${operation} revision`,
		);
	}
	return {
		subscription: toReadModel(
			subscriptionId,
			args.userId,
			insertedRev,
			insertedRev.createdAt,
		),
		idempotentReplay: false,
	};
}

export interface RegisterPushSubscriptionParams {
	db: Database;
	userId: unknown;
	endpoint: unknown;
	p256dh: unknown;
	auth: unknown;
	expirationTime?: unknown;
	userAgent?: unknown;
	occurredAt: unknown;
	idempotencyKey: unknown;
}

export async function registerPushSubscription(
	params: RegisterPushSubscriptionParams,
): Promise<{
	subscription: PushSubscriptionReadModel;
	idempotentReplay: boolean;
}> {
	const userId = validateNotificationCanonicalUuid(params.userId, "userId");
	const endpoint = validateNotificationPushEndpoint(params.endpoint);
	const p256dh = validateNotificationP256dh(params.p256dh);
	// Phase 15-R1 Section C: structural validation alone does not prove the
	// point is on-curve. Pure crypto, zero DB calls, before any transaction.
	await assertP256dhOnCurve(p256dh);
	const auth = validateNotificationAuth(params.auth);
	const expirationTime = validateNotificationOptionalExpirationTime(
		params.expirationTime,
	);
	const userAgent = validateNotificationOptionalText(
		params.userAgent,
		"userAgent",
		500,
	);
	const occurredAt = validateNotificationOccurredAt(params.occurredAt);
	const idempotencyKey = validateNotificationIdempotencyKey(
		params.idempotencyKey,
	);

	return runNotificationTransaction(params.db, (tx) =>
		registerPushSubscriptionInTransaction(tx, {
			userId,
			endpoint,
			p256dh,
			auth,
			expirationTime,
			userAgent,
			occurredAt,
			idempotencyKey,
		}),
	);
}

// ============================================================================
// DISABLE
// ============================================================================

export interface DisablePushSubscriptionInTransactionArgs {
	userId: string;
	subscriptionId: string;
	disableReason: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export async function disablePushSubscriptionInTransaction(
	tx: DatabaseTransaction,
	args: DisablePushSubscriptionInTransactionArgs,
): Promise<{
	subscription: PushSubscriptionReadModel;
	idempotentReplay: boolean;
}> {
	const tryReplay = async (
		existingRev: typeof pushSubscriptionRevisions.$inferSelect,
	) => {
		if (
			existingRev.subscriptionId !== args.subscriptionId ||
			existingRev.operation !== "DISABLE"
		) {
			throw new NotificationError(
				"NOTIFICATION_IDEMPOTENCY_CONFLICT",
				"Idempotency key was already used for a different push subscription operation",
			);
		}
		const candidateFingerprint =
			await calculatePushSubscriptionDisableFingerprint({
				userId: args.userId,
				subscriptionId: args.subscriptionId,
				expectedRevisionNo: existingRev.revisionNo,
				disableReason: args.disableReason,
				occurredAt: args.occurredAt,
			});
		if (candidateFingerprint !== existingRev.revisionFingerprint) {
			throw new NotificationError(
				"NOTIFICATION_IDEMPOTENCY_CONFLICT",
				"Idempotency key reused with a different DISABLE payload",
			);
		}
		const [anchor] = await tx
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.id, args.subscriptionId))
			.limit(1);
		if (!anchor) {
			throw new NotificationError(
				"NOTIFICATION_SUBSCRIPTION_NOT_FOUND",
				"Push subscription not found",
			);
		}
		return {
			subscription: toReadModel(
				anchor.id,
				anchor.userId,
				existingRev,
				anchor.createdAt,
			),
			idempotentReplay: true as const,
		};
	};

	const earlyRev = await findRevisionByIdempotencyKeyInTransaction(
		tx,
		args.userId,
		args.idempotencyKey,
	);
	if (earlyRev) return tryReplay(earlyRev);

	const [anchor] = await tx
		.select()
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.id, args.subscriptionId))
		.limit(1);
	if (!anchor || anchor.userId !== args.userId) {
		throw new NotificationError(
			"NOTIFICATION_SUBSCRIPTION_NOT_FOUND",
			"Push subscription not found",
		);
	}

	const secondRev = await findRevisionByIdempotencyKeyInTransaction(
		tx,
		args.userId,
		args.idempotencyKey,
	);
	if (secondRev) return tryReplay(secondRev);

	const latest = await findLatestRevisionInTransaction(tx, args.subscriptionId);
	if (!latest) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_STATE",
			"Push subscription anchor has no revisions",
		);
	}
	if (latest.status !== "ACTIVE") {
		throw new NotificationError(
			"NOTIFICATION_SUBSCRIPTION_DISABLED",
			"Push subscription is already DISABLED",
		);
	}

	const fingerprint = await calculatePushSubscriptionDisableFingerprint({
		userId: args.userId,
		subscriptionId: args.subscriptionId,
		expectedRevisionNo: latest.revisionNo + 1,
		disableReason: args.disableReason,
		occurredAt: args.occurredAt,
	});

	const [insertedRev] = await tx
		.insert(pushSubscriptionRevisions)
		.values({
			userId: args.userId,
			subscriptionId: args.subscriptionId,
			revisionNo: latest.revisionNo + 1,
			previousRevisionId: latest.id,
			operation: "DISABLE",
			status: "DISABLED",
			endpoint: latest.endpoint,
			p256dh: latest.p256dh,
			auth: latest.auth,
			expirationTime: latest.expirationTime,
			userAgent: latest.userAgent,
			disableReason: args.disableReason,
			occurredAt: args.occurredAt,
			idempotencyKey: args.idempotencyKey,
			revisionFingerprint: fingerprint,
		})
		.returning();
	if (!insertedRev) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_STATE",
			"Failed to create push subscription DISABLE revision",
		);
	}
	return {
		subscription: toReadModel(
			args.subscriptionId,
			args.userId,
			insertedRev,
			anchor.createdAt,
		),
		idempotentReplay: false,
	};
}

export interface DisablePushSubscriptionParams {
	db: Database;
	userId: unknown;
	subscriptionId: unknown;
	disableReason?: unknown;
	occurredAt: unknown;
	idempotencyKey: unknown;
}

export async function disablePushSubscription(
	params: DisablePushSubscriptionParams,
): Promise<{
	subscription: PushSubscriptionReadModel;
	idempotentReplay: boolean;
}> {
	const userId = validateNotificationCanonicalUuid(params.userId, "userId");
	const subscriptionId = validateNotificationCanonicalUuid(
		params.subscriptionId,
		"subscriptionId",
	);
	const disableReason = validateNotificationOptionalText(
		params.disableReason,
		"disableReason",
		500,
	);
	const occurredAt = validateNotificationOccurredAt(params.occurredAt);
	const idempotencyKey = validateNotificationIdempotencyKey(
		params.idempotencyKey,
	);

	return runNotificationTransaction(params.db, (tx) =>
		disablePushSubscriptionInTransaction(tx, {
			userId,
			subscriptionId,
			disableReason,
			occurredAt,
			idempotencyKey,
		}),
	);
}

/**
 * Atomically appends a DISABLE revision keyed off a deterministic
 * `PUSH_ENDPOINT_GONE:<subscriptionId>:...` derived idempotency key (Section
 * 9). Never hard-deletes the subscription row. Safe to call from the
 * delivery/scheduler layer when the push transport reports 404/410.
 *
 * @deprecated Phase 15-R1 Section B: this unconditionally disables whatever
 * revision is LATEST at call time, which is racy if a REFRESH/REACTIVATE was
 * appended between when the 404/410 dispatch was sent and when its result is
 * finalized. Callers driven by the scheduler's dispatch-reservation
 * architecture must use
 * `disablePushSubscriptionForEndpointGoneIfStillLatestInTransaction` instead,
 * which only disables when the EXACT revision the dispatch was sent against
 * is still the latest. Kept for any caller that has no dispatch-bound
 * revision id to compare against.
 */
export async function disablePushSubscriptionForEndpointGoneInTransaction(
	tx: DatabaseTransaction,
	args: {
		userId: string;
		subscriptionId: string;
		occurredAt: Date;
		idempotencyKey: string;
	},
): Promise<void> {
	await disablePushSubscriptionInTransaction(tx, {
		userId: args.userId,
		subscriptionId: args.subscriptionId,
		disableReason: "PUSH_ENDPOINT_GONE",
		occurredAt: args.occurredAt,
		idempotencyKey: args.idempotencyKey,
	});
}

/**
 * Phase 15-R1 Section B/10/11, hardened by Phase 15-R2 Section B: race-safe
 * endpoint-gone auto-disable. Only appends a DISABLE revision when
 * `expectedRevisionId` -- the EXACT `push_subscription_revision_id` that was
 * bound to the dispatch reservation whose network call actually returned
 * 404/410 -- is STILL the subscription's current latest revision at
 * finalization time. If a REFRESH/REACTIVATE was appended in between (a real
 * race under this architecture), the newer revision is left untouched and
 * this is a no-op: the old dispatch's result simply remains recorded as
 * TERMINAL_FAILURE, and the subscription stays ACTIVE on its newer revision.
 * Comparing by exact revision id is strictly stronger than comparing
 * individual fields (endpoint/p256dh/auth) since a revision id uniquely
 * determines every one of its fields.
 *
 * The `push_subscriptions` anchor is locked FOR UPDATE and held for the
 * remainder of this transaction BEFORE resolving latest, so the whole
 * decision (lock -> validate user -> resolve latest -> compare -> append
 * DISABLE) is made under one uninterrupted hold: no concurrent REFRESH can
 * even start its own revision insert (which re-locks this same row) until
 * this transaction commits or rolls back, closing the check-then-act race
 * window that existed when latest was resolved without first taking this
 * lock.
 */
export async function disablePushSubscriptionForEndpointGoneIfStillLatestInTransaction(
	tx: DatabaseTransaction,
	args: {
		userId: string;
		subscriptionId: string;
		expectedRevisionId: string;
		occurredAt: Date;
		idempotencyKey: string;
	},
): Promise<{ disabled: boolean }> {
	const [anchor] = await tx
		.select()
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.id, args.subscriptionId))
		.for("update");
	if (!anchor || anchor.userId !== args.userId) {
		return { disabled: false };
	}
	const latest = await findLatestRevisionInTransaction(tx, args.subscriptionId);
	if (!latest || latest.id !== args.expectedRevisionId) {
		return { disabled: false };
	}
	await disablePushSubscriptionInTransaction(tx, {
		userId: args.userId,
		subscriptionId: args.subscriptionId,
		disableReason: "PUSH_ENDPOINT_GONE",
		occurredAt: args.occurredAt,
		idempotencyKey: args.idempotencyKey,
	});
	return { disabled: true };
}

/**
 * Resolves the subscription's current ACTIVE revision inside an already-open
 * transaction (used by the scheduler's dispatch-reservation Transaction A --
 * Phase 15-R1 Section A/B). Returns null if the subscription is no longer
 * ACTIVE (e.g. disabled concurrently since the outer active-subscription
 * listing was taken).
 *
 * Phase 15-R2 Section A: locks the `push_subscriptions` anchor row FOR UPDATE
 * BEFORE resolving latest -- the same row the DB's
 * `trg_fn_guard_push_subscription_revision_insert` trigger locks for a
 * REFRESH/REACTIVATE/DISABLE revision insert. Taking this lock here means
 * that by the time the caller reserves a dispatch, a concurrent subscription
 * lifecycle mutation has either already committed (and this resolves the
 * newer revision) or cannot proceed until this transaction commits/rolls
 * back -- making the resolve-then-reserve two-step race-free in the normal
 * path. The DB trigger's own re-lock/re-check on the dispatch insert remains
 * as defense-in-depth for any other caller. Lock ordering is always
 * delivery -> subscription here (the scheduler already locks the delivery
 * row via `lockDeliveryHistoryInTransaction` earlier in the same
 * transaction); subscription lifecycle mutations never lock
 * `notification_deliveries`, so no lock-order cycle is possible.
 */
export async function getActiveSubscriptionRevisionInTransaction(
	tx: DatabaseTransaction,
	subscriptionId: string,
): Promise<typeof pushSubscriptionRevisions.$inferSelect | null> {
	await tx
		.select({ id: pushSubscriptions.id })
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.id, subscriptionId))
		.for("update");
	const latest = await findLatestRevisionInTransaction(tx, subscriptionId);
	if (latest?.status !== "ACTIVE") return null;
	return latest;
}

// ============================================================================
// READ
// ============================================================================

export interface GetPushSubscriptionParams {
	db: Database;
	userId: unknown;
	subscriptionId: unknown;
}

export async function getPushSubscription(
	params: GetPushSubscriptionParams,
): Promise<PushSubscriptionReadModel | null> {
	const userId = validateNotificationCanonicalUuid(params.userId, "userId");
	const subscriptionId = validateNotificationCanonicalUuid(
		params.subscriptionId,
		"subscriptionId",
	);
	return runNotificationReadTransaction(params.db, async (tx) => {
		const [anchor] = await tx
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.id, subscriptionId))
			.limit(1);
		if (!anchor || anchor.userId !== userId) return null;
		const latest = await findLatestRevisionInTransaction(tx, subscriptionId);
		if (!latest) return null;
		return toReadModel(anchor.id, anchor.userId, latest, anchor.createdAt);
	});
}

export interface ListPushSubscriptionsParams {
	db: Database;
	userId: unknown;
	status?: unknown;
}

export async function listPushSubscriptions(
	params: ListPushSubscriptionsParams,
): Promise<PushSubscriptionReadModel[]> {
	const userId = validateNotificationCanonicalUuid(params.userId, "userId");
	// Phase 15-R1 Section H/27: strict runtime validation BEFORE any DB call
	// -- only `undefined` means "omitted"; never a truthiness check (which
	// would incorrectly treat "" as omitted rather than invalid).
	const status = validateNotificationOptionalSubscriptionStatus(params.status);
	return runNotificationReadTransaction(params.db, async (tx) => {
		const anchors = await tx
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.userId, userId));
		const results: PushSubscriptionReadModel[] = [];
		for (const anchor of anchors) {
			const latest = await findLatestRevisionInTransaction(tx, anchor.id);
			if (!latest) continue;
			if (status !== undefined && latest.status !== status) continue;
			results.push(
				toReadModel(anchor.id, anchor.userId, latest, anchor.createdAt),
			);
		}
		results.sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
		return results;
	});
}

/**
 * Resolves a user's currently-ACTIVE push subscriptions inside an already-open
 * transaction (used by the delivery/scheduler layer -- Section 18).
 */
export async function listActivePushSubscriptionsInTransaction(
	tx: DatabaseTransaction,
	userId: string,
): Promise<PushSubscriptionReadModel[]> {
	const anchors = await tx
		.select()
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.userId, userId));
	const results: PushSubscriptionReadModel[] = [];
	for (const anchor of anchors) {
		const latest = await findLatestRevisionInTransaction(tx, anchor.id);
		if (latest?.status !== "ACTIVE") continue;
		results.push(
			toReadModel(anchor.id, anchor.userId, latest, anchor.createdAt),
		);
	}
	return results;
}

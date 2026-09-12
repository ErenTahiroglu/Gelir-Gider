import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, eq } from "drizzle-orm";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase, type Database } from "../db/client";
import {
	CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES,
	type CreditCardPurchaseBudgetCategory,
} from "../db/schema/credit-card-ledger";
import { creditCardPurchaseSplitParticipants } from "../db/schema/credit-card-splits";
import {
	PERSON_OBLIGATION_DIRECTIONS,
	PERSON_RELATIONSHIPS,
	PERSON_STATUSES,
	type PersonObligationDirection,
	type PersonRelationship,
} from "../db/schema/people";
import {
	archivePerson,
	createPerson,
	getPerson,
	listPeople,
	updatePerson,
} from "../people/people";
import {
	getPersonObligation,
	listPersonObligations,
	recordPersonPayableExpense,
	recordPersonReceivable,
	updatePersonPayableExpense,
	updatePersonReceivable,
	voidPersonObligation,
} from "../people/obligations";
import {
	getPersonSettlement,
	listPersonSettlements,
	recordPersonPayableSettlement,
	recordPersonReceivableSettlement,
	voidPersonSettlement,
} from "../people/settlements";
import { PeopleError } from "../people/errors";
import { validateIsoCalendarDate } from "../people/calendar";
import { parsePositiveMoneyString } from "../ledger/money";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	hasOnlyKeys,
	isUuid,
	parseBoundedLimit,
	parseCanonicalInstant,
	readIdempotencyKey,
	readJsonObject,
	sameOriginMutationGuard,
} from "./transport";

type PeopleEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const peopleRouter = new Hono<PeopleEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<PeopleEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapPeopleDomainError(c: Context<PeopleEnv>, err: unknown) {
	if (err instanceof PeopleError) {
		switch (err.code) {
			case "PEOPLE_INVALID_INPUT":
			case "PEOPLE_LEDGER_ACCOUNT_INVALID":
				return fail(c, err.code, 400);
			case "PEOPLE_NOT_FOUND":
			case "PEOPLE_OBLIGATION_NOT_FOUND":
			case "PEOPLE_SETTLEMENT_NOT_FOUND":
				return fail(c, err.code, 404);
			case "PEOPLE_NOT_ACTIVE":
			case "PEOPLE_REVISION_CONFLICT":
			case "PEOPLE_OBLIGATION_NOT_ACTIVE":
			case "PEOPLE_OBLIGATION_REVISION_CONFLICT":
			case "PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT":
			case "PEOPLE_OBLIGATION_OVERSETTLEMENT":
			case "PEOPLE_IDEMPOTENCY_CONFLICT":
			case "PEOPLE_OBLIGATION_SPLIT_MANAGED":
				return fail(c, err.code, 409);
			case "PEOPLE_INVALID_STATE":
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

function validateStrictQueryParams(
	c: Context,
	allowedKeys: readonly string[],
): boolean {
	const url = new URL(c.req.url);
	const seen = new Set<string>();
	for (const key of url.searchParams.keys()) {
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		if (!allowedKeys.includes(key)) {
			return false;
		}
	}
	return true;
}

async function checkIsSplitManaged(
	db: Database,
	userId: string,
	obligationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: creditCardPurchaseSplitParticipants.id })
		.from(creditCardPurchaseSplitParticipants)
		.where(
			and(
				eq(creditCardPurchaseSplitParticipants.userId, userId),
				eq(creditCardPurchaseSplitParticipants.personObligationId, obligationId),
			),
		)
		.limit(1);
	return Boolean(row);
}

// Global middlewares for all People product routes
peopleRouter.use("*", sameOriginMutationGuard());
peopleRouter.use("*", requireAuthenticatedSession);
peopleRouter.post(
	"*",
	bodyLimit({
		maxSize: BODY_LIMIT_BYTES,
		onError: (c) => fail(c, "PEOPLE_INVALID_INPUT", 400),
	}),
);

// ============================================================================
// 1. PEOPLE IDENTITY SURFACE
// ============================================================================

/**
 * 1.1 GET /people
 * Lists people for the authenticated user with optional status and relationship filters.
 */
peopleRouter.get("/", async (c) => {
	if (!validateStrictQueryParams(c, ["limit", "status", "relationship"])) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const statusQuery = c.req.query("status");
	let statusFilter: "ACTIVE" | "ARCHIVED" | undefined;
	if (statusQuery !== undefined) {
		if (!PERSON_STATUSES.includes(statusQuery as "ACTIVE" | "ARCHIVED")) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery as "ACTIVE" | "ARCHIVED";
	}

	const relationshipQuery = c.req.query("relationship");
	let relationshipFilter: PersonRelationship | undefined;
	if (relationshipQuery !== undefined) {
		if (!PERSON_RELATIONSHIPS.includes(relationshipQuery as PersonRelationship)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		relationshipFilter = relationshipQuery as PersonRelationship;
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const allPeople = await listPeople({
			db,
			userId: auth.userId,
			status: statusFilter,
			relationship: relationshipFilter,
		});

		const peopleList = allPeople.slice(0, limitRes.limit);

		return c.json(
			{
				people: peopleList,
				limit: limitRes.limit,
			},
			200,
		);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 1.2 GET /people/:id
 * Fetches a single person by ID for the authenticated user.
 */
peopleRouter.get("/:id", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const personId = c.req.param("id");
	if (!isUuid(personId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const person = await getPerson({
			db,
			userId: auth.userId,
			personId,
		});

		if (!person) {
			return fail(c, "PEOPLE_NOT_FOUND", 404);
		}

		return c.json({ person }, 200);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 1.3 POST /people
 * Creates a new person contact for the authenticated user.
 */
peopleRouter.post("/", async (c) => {
	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const allowedKeys = ["displayName", "relationship", "note", "occurredAt"];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const {
		displayName,
		relationship,
		note,
		occurredAt: rawOccurredAt,
	} = bodyRes.value;

	if (
		typeof displayName !== "string" ||
		displayName.trim().length === 0 ||
		displayName.trim().length > 120
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (
		typeof relationship !== "string" ||
		!PERSON_RELATIONSHIPS.includes(relationship as PersonRelationship)
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (note !== undefined && note !== null) {
		if (typeof note !== "string" || note.length > 500) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await createPerson({
			db,
			userId: auth.userId,
			displayName: displayName.trim(),
			relationship: relationship as PersonRelationship,
			note: note !== undefined && note !== null ? (note as string).trim() : null,
			occurredAt,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 1.4 POST /people/:id
 * Updates an existing person's details (OCC revision check).
 */
peopleRouter.post("/:id", async (c) => {
	const personId = c.req.param("id");
	if (!isUuid(personId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const allowedKeys = [
		"expectedRevisionNo",
		"displayName",
		"relationship",
		"note",
		"occurredAt",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const {
		expectedRevisionNo,
		displayName,
		relationship,
		note,
		occurredAt: rawOccurredAt,
	} = bodyRes.value;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (
		typeof displayName !== "string" ||
		displayName.trim().length === 0 ||
		displayName.trim().length > 120
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (
		typeof relationship !== "string" ||
		!PERSON_RELATIONSHIPS.includes(relationship as PersonRelationship)
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (note !== undefined && note !== null) {
		if (typeof note !== "string" || note.length > 500) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await updatePerson({
			db,
			userId: auth.userId,
			personId,
			expectedRevisionNo,
			displayName: displayName.trim(),
			relationship: relationship as PersonRelationship,
			note: note !== undefined && note !== null ? (note as string).trim() : null,
			occurredAt,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 1.5 POST /people/:id/archive
 * Archives a person contact (OCC revision check).
 */
peopleRouter.post("/:id/archive", async (c) => {
	const personId = c.req.param("id");
	if (!isUuid(personId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const allowedKeys = ["expectedRevisionNo", "occurredAt"];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const { expectedRevisionNo, occurredAt: rawOccurredAt } = bodyRes.value;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await archivePerson({
			db,
			userId: auth.userId,
			personId,
			expectedRevisionNo,
			occurredAt,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

// ============================================================================
// 2. OBLIGATIONS SURFACE
// ============================================================================

/**
 * 2.1 GET /people/:personId/obligations
 * Lists obligations for a given person with optional direction/status/dueDate filters.
 */
peopleRouter.get("/:personId/obligations", async (c) => {
	const personId = c.req.param("personId");
	if (!isUuid(personId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (
		!validateStrictQueryParams(c, [
			"limit",
			"direction",
			"status",
			"dueDateFrom",
			"dueDateUntil",
		])
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const directionQuery = c.req.query("direction");
	let directionFilter: PersonObligationDirection | undefined;
	if (directionQuery !== undefined) {
		if (
			!PERSON_OBLIGATION_DIRECTIONS.includes(
				directionQuery as PersonObligationDirection,
			)
		) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		directionFilter = directionQuery as PersonObligationDirection;
	}

	const statusQuery = c.req.query("status");
	let statusFilter: "OPEN" | "SETTLED" | "VOID" | undefined;
	if (statusQuery !== undefined) {
		if (
			statusQuery !== "OPEN" &&
			statusQuery !== "SETTLED" &&
			statusQuery !== "VOID"
		) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery;
	}

	const rawDueDateFrom = c.req.query("dueDateFrom");
	let dueDateFrom: string | undefined;
	if (rawDueDateFrom !== undefined) {
		try {
			dueDateFrom = validateIsoCalendarDate(rawDueDateFrom);
		} catch {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	const rawDueDateUntil = c.req.query("dueDateUntil");
	let dueDateUntil: string | undefined;
	if (rawDueDateUntil !== undefined) {
		try {
			dueDateUntil = validateIsoCalendarDate(rawDueDateUntil);
		} catch {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const person = await getPerson({
			db,
			userId: auth.userId,
			personId,
		});
		if (!person) {
			return fail(c, "PEOPLE_NOT_FOUND", 404);
		}

		const rawObligations = await listPersonObligations({
			db,
			userId: auth.userId,
			personId,
			direction: directionFilter,
			status: statusFilter,
			dueDateFrom,
			dueDateUntil,
		});

		const splitParticipantRows = await db
			.select({
				obligationId: creditCardPurchaseSplitParticipants.personObligationId,
			})
			.from(creditCardPurchaseSplitParticipants)
			.where(eq(creditCardPurchaseSplitParticipants.userId, auth.userId));
		const splitObligationIds = new Set(
			splitParticipantRows.map((r) => r.obligationId),
		);

		const obligations = rawObligations
			.slice(0, limitRes.limit)
			.map((obl) => ({
				...obl,
				isSplitManaged: splitObligationIds.has(obl.obligationId),
			}));

		return c.json(
			{
				obligations,
				limit: limitRes.limit,
			},
			200,
		);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 2.2 GET /people/:personId/obligations/:id
 * Fetches a single obligation by ID.
 */
peopleRouter.get("/:personId/obligations/:id", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const personId = c.req.param("personId");
	const obligationId = c.req.param("id");

	if (!isUuid(personId) || !isUuid(obligationId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const obligation = await getPersonObligation({
			db,
			userId: auth.userId,
			obligationId,
		});

		if (!obligation || obligation.personId !== personId) {
			return fail(c, "PEOPLE_OBLIGATION_NOT_FOUND", 404);
		}

		const isSplitManaged = await checkIsSplitManaged(
			db,
			auth.userId,
			obligationId,
		);

		return c.json(
			{
				obligation: {
					...obligation,
					isSplitManaged,
				},
			},
			200,
		);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 2.3 POST /people/:personId/obligations/receivable
 * Records an advance/loan made to a person (RECEIVABLE obligation).
 */
peopleRouter.post("/:personId/obligations/receivable", async (c) => {
	const personId = c.req.param("personId");
	if (!isUuid(personId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const allowedKeys = [
		"amount",
		"fundingAssetAccountId",
		"occurredAt",
		"dueDate",
		"description",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const {
		amount,
		fundingAssetAccountId,
		occurredAt: rawOccurredAt,
		dueDate: rawDueDate,
		description,
	} = bodyRes.value;

	if (typeof amount !== "string") {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}
	try {
		parsePositiveMoneyString(amount);
	} catch {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (
		typeof fundingAssetAccountId !== "string" ||
		!isUuid(fundingAssetAccountId)
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	let dueDate: string | null = null;
	if (rawDueDate !== undefined && rawDueDate !== null) {
		if (typeof rawDueDate !== "string") {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		try {
			dueDate = validateIsoCalendarDate(rawDueDate);
		} catch {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	if (description !== undefined && description !== null) {
		if (typeof description !== "string" || description.length > 500) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await recordPersonReceivable({
			db,
			userId: auth.userId,
			personId,
			amount,
			fundingAssetAccountId,
			occurredAt,
			dueDate,
			description:
				description !== undefined && description !== null
					? (description as string).trim()
					: null,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 2.4 POST /people/:personId/obligations/payable
 * Records a payable expense owed to a person (PAYABLE obligation).
 */
peopleRouter.post("/:personId/obligations/payable", async (c) => {
	const personId = c.req.param("personId");
	if (!isUuid(personId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const allowedKeys = [
		"amount",
		"budgetCategory",
		"occurredAt",
		"dueDate",
		"description",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const {
		amount,
		budgetCategory,
		occurredAt: rawOccurredAt,
		dueDate: rawDueDate,
		description,
	} = bodyRes.value;

	if (typeof amount !== "string") {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}
	try {
		parsePositiveMoneyString(amount);
	} catch {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (
		typeof budgetCategory !== "string" ||
		!CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES.includes(
			budgetCategory as CreditCardPurchaseBudgetCategory,
		)
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	let dueDate: string | null = null;
	if (rawDueDate !== undefined && rawDueDate !== null) {
		if (typeof rawDueDate !== "string") {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		try {
			dueDate = validateIsoCalendarDate(rawDueDate);
		} catch {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	if (description !== undefined && description !== null) {
		if (typeof description !== "string" || description.length > 500) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await recordPersonPayableExpense({
			db,
			userId: auth.userId,
			personId,
			amount,
			budgetCategory: budgetCategory as CreditCardPurchaseBudgetCategory,
			occurredAt,
			dueDate,
			description:
				description !== undefined && description !== null
					? (description as string).trim()
					: null,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 2.5 POST /people/:personId/obligations/:id
 * Updates an obligation (dispatches to receivable or payable based on obligation direction).
 * Split-managed obligations are rejected with 409 PEOPLE_OBLIGATION_SPLIT_MANAGED.
 */
peopleRouter.post("/:personId/obligations/:id", async (c) => {
	const personId = c.req.param("personId");
	const obligationId = c.req.param("id");

	if (!isUuid(personId) || !isUuid(obligationId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const allowedKeys = [
		"expectedRevisionNo",
		"amount",
		"fundingAssetAccountId",
		"budgetCategory",
		"occurredAt",
		"dueDate",
		"description",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const {
		expectedRevisionNo,
		amount,
		fundingAssetAccountId,
		budgetCategory,
		occurredAt: rawOccurredAt,
		dueDate: rawDueDate,
		description,
	} = bodyRes.value;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	if (typeof amount !== "string") {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}
	try {
		parsePositiveMoneyString(amount);
	} catch {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	let dueDate: string | null = null;
	if (rawDueDate !== undefined && rawDueDate !== null) {
		if (typeof rawDueDate !== "string") {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		try {
			dueDate = validateIsoCalendarDate(rawDueDate);
		} catch {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	if (description !== undefined && description !== null) {
		if (typeof description !== "string" || description.length > 500) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		// 1. Guard: Check if split-managed before anything else
		const isSplit = await checkIsSplitManaged(db, auth.userId, obligationId);
		if (isSplit) {
			return fail(c, "PEOPLE_OBLIGATION_SPLIT_MANAGED", 409);
		}

		// 2. Fetch existing obligation to determine direction & verify owner/person
		const existing = await getPersonObligation({
			db,
			userId: auth.userId,
			obligationId,
		});

		if (!existing || existing.personId !== personId) {
			return fail(c, "PEOPLE_OBLIGATION_NOT_FOUND", 404);
		}

		if (existing.direction === "RECEIVABLE") {
			if (
				typeof fundingAssetAccountId !== "string" ||
				!isUuid(fundingAssetAccountId)
			) {
				return fail(c, "PEOPLE_INVALID_INPUT", 400);
			}
			if (budgetCategory !== undefined && budgetCategory !== null) {
				return fail(c, "PEOPLE_INVALID_INPUT", 400);
			}

			const result = await updatePersonReceivable({
				db,
				userId: auth.userId,
				obligationId,
				expectedRevisionNo,
				amount,
				fundingAssetAccountId,
				occurredAt,
				dueDate,
				description:
					description !== undefined && description !== null
						? (description as string).trim()
						: null,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		}

		if (existing.direction === "PAYABLE") {
			if (
				typeof budgetCategory !== "string" ||
				!CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES.includes(
					budgetCategory as CreditCardPurchaseBudgetCategory,
				)
			) {
				return fail(c, "PEOPLE_INVALID_INPUT", 400);
			}
			if (
				fundingAssetAccountId !== undefined &&
				fundingAssetAccountId !== null
			) {
				return fail(c, "PEOPLE_INVALID_INPUT", 400);
			}

			const result = await updatePersonPayableExpense({
				db,
				userId: auth.userId,
				obligationId,
				expectedRevisionNo,
				amount,
				budgetCategory: budgetCategory as CreditCardPurchaseBudgetCategory,
				occurredAt,
				dueDate,
				description:
					description !== undefined && description !== null
						? (description as string).trim()
						: null,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		}

		return fail(c, "PEOPLE_INVALID_STATE", 500);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

/**
 * 2.6 POST /people/:personId/obligations/:id/void
 * Voids an obligation (OCC revision check).
 * Split-managed obligations are rejected with 409 PEOPLE_OBLIGATION_SPLIT_MANAGED.
 */
peopleRouter.post("/:personId/obligations/:id/void", async (c) => {
	const personId = c.req.param("personId");
	const obligationId = c.req.param("id");

	if (!isUuid(personId) || !isUuid(obligationId)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

	const allowedKeys = ["expectedRevisionNo"];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const { expectedRevisionNo } = bodyRes.value;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "PEOPLE_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		// 1. Guard: Check if split-managed
		const isSplit = await checkIsSplitManaged(db, auth.userId, obligationId);
		if (isSplit) {
			return fail(c, "PEOPLE_OBLIGATION_SPLIT_MANAGED", 409);
		}

		// 2. Fetch obligation to verify personId
		const existing = await getPersonObligation({
			db,
			userId: auth.userId,
			obligationId,
		});
		if (!existing || existing.personId !== personId) {
			return fail(c, "PEOPLE_OBLIGATION_NOT_FOUND", 404);
		}

		const result = await voidPersonObligation({
			db,
			userId: auth.userId,
			obligationId,
			expectedRevisionNo,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapPeopleDomainError(c, err);
	}
});

// ============================================================================
// 3. SETTLEMENTS SURFACE
// ============================================================================

/**
 * 3.1 GET /people/:personId/obligations/:obligationId/settlements
 * Lists settlements for an obligation.
 */
peopleRouter.get(
	"/:personId/obligations/:obligationId/settlements",
	async (c) => {
		const personId = c.req.param("personId");
		const obligationId = c.req.param("obligationId");

		if (!isUuid(personId) || !isUuid(obligationId)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		if (!validateStrictQueryParams(c, ["limit", "status"])) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const limitRes = parseBoundedLimit(c.req.query("limit"), {
			defaultLimit: 50,
			maxLimit: 100,
		});
		if (!limitRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		const statusQuery = c.req.query("status");
		let statusFilter: "ACTIVE" | "VOIDED" | undefined;
		if (statusQuery !== undefined) {
			if (statusQuery !== "ACTIVE" && statusQuery !== "VOIDED") {
				return fail(c, "PEOPLE_INVALID_INPUT", 400);
			}
			statusFilter = statusQuery;
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const obligation = await getPersonObligation({
				db,
				userId: auth.userId,
				obligationId,
			});
			if (!obligation || obligation.personId !== personId) {
				return fail(c, "PEOPLE_OBLIGATION_NOT_FOUND", 404);
			}

			const allSettlements = await listPersonSettlements({
				db,
				userId: auth.userId,
				obligationId,
				status: statusFilter,
			});

			const settlements = allSettlements.slice(0, limitRes.limit);

			return c.json(
				{
					settlements,
					limit: limitRes.limit,
				},
				200,
			);
		} catch (err) {
			return mapPeopleDomainError(c, err);
		}
	},
);

/**
 * 3.2 GET /people/:personId/obligations/:obligationId/settlements/:id
 * Fetches a single settlement by ID.
 */
peopleRouter.get(
	"/:personId/obligations/:obligationId/settlements/:id",
	async (c) => {
		if (!validateStrictQueryParams(c, [])) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const personId = c.req.param("personId");
		const obligationId = c.req.param("obligationId");
		const settlementId = c.req.param("id");

		if (!isUuid(personId) || !isUuid(obligationId) || !isUuid(settlementId)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const settlement = await getPersonSettlement({
				db,
				userId: auth.userId,
				settlementId,
			});

			if (
				!settlement ||
				settlement.obligationId !== obligationId ||
				settlement.personId !== personId
			) {
				return fail(c, "PEOPLE_SETTLEMENT_NOT_FOUND", 404);
			}

			return c.json({ settlement }, 200);
		} catch (err) {
			return mapPeopleDomainError(c, err);
		}
	},
);

/**
 * 3.3 POST /people/:personId/obligations/:obligationId/settlements/receivable
 * Records a settlement payment received against a RECEIVABLE obligation.
 */
peopleRouter.post(
	"/:personId/obligations/:obligationId/settlements/receivable",
	async (c) => {
		const personId = c.req.param("personId");
		const obligationId = c.req.param("obligationId");

		if (!isUuid(personId) || !isUuid(obligationId)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		const allowedKeys = [
			"cashAmount",
			"destinationAssetAccountId",
			"occurredAt",
			"note",
		];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const {
			cashAmount,
			destinationAssetAccountId,
			occurredAt: rawOccurredAt,
			note,
		} = bodyRes.value;

		if (typeof cashAmount !== "string") {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		try {
			parsePositiveMoneyString(cashAmount);
		} catch {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		if (
			typeof destinationAssetAccountId !== "string" ||
			!isUuid(destinationAssetAccountId)
		) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		if (note !== undefined && note !== null) {
			if (typeof note !== "string" || note.length > 500) {
				return fail(c, "PEOPLE_INVALID_INPUT", 400);
			}
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const obligation = await getPersonObligation({
				db,
				userId: auth.userId,
				obligationId,
			});
			if (!obligation || obligation.personId !== personId) {
				return fail(c, "PEOPLE_OBLIGATION_NOT_FOUND", 404);
			}

			const result = await recordPersonReceivableSettlement({
				db,
				userId: auth.userId,
				obligationId,
				cashAmount,
				destinationAssetAccountId,
				occurredAt,
				note: note !== undefined && note !== null ? (note as string).trim() : null,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapPeopleDomainError(c, err);
		}
	},
);

/**
 * 3.4 POST /people/:personId/obligations/:obligationId/settlements/payable
 * Records a settlement payment made against a PAYABLE obligation.
 */
peopleRouter.post(
	"/:personId/obligations/:obligationId/settlements/payable",
	async (c) => {
		const personId = c.req.param("personId");
		const obligationId = c.req.param("obligationId");

		if (!isUuid(personId) || !isUuid(obligationId)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		const allowedKeys = ["amount", "sourceAssetAccountId", "occurredAt", "note"];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const {
			amount,
			sourceAssetAccountId,
			occurredAt: rawOccurredAt,
			note,
		} = bodyRes.value;

		if (typeof amount !== "string") {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}
		try {
			parsePositiveMoneyString(amount);
		} catch {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		if (
			typeof sourceAssetAccountId !== "string" ||
			!isUuid(sourceAssetAccountId)
		) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		if (note !== undefined && note !== null) {
			if (typeof note !== "string" || note.length > 500) {
				return fail(c, "PEOPLE_INVALID_INPUT", 400);
			}
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const obligation = await getPersonObligation({
				db,
				userId: auth.userId,
				obligationId,
			});
			if (!obligation || obligation.personId !== personId) {
				return fail(c, "PEOPLE_OBLIGATION_NOT_FOUND", 404);
			}

			const result = await recordPersonPayableSettlement({
				db,
				userId: auth.userId,
				obligationId,
				amount,
				sourceAssetAccountId,
				occurredAt,
				note: note !== undefined && note !== null ? (note as string).trim() : null,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapPeopleDomainError(c, err);
		}
	},
);

/**
 * 3.5 POST /people/:personId/obligations/:obligationId/settlements/:id/void
 * Voids a settlement payment (OCC revision check).
 */
peopleRouter.post(
	"/:personId/obligations/:obligationId/settlements/:id/void",
	async (c) => {
		const personId = c.req.param("personId");
		const obligationId = c.req.param("obligationId");
		const settlementId = c.req.param("id");

		if (!isUuid(personId) || !isUuid(obligationId) || !isUuid(settlementId)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "PEOPLE_INVALID_INPUT", 400);

		const allowedKeys = ["expectedRevisionNo", "reason"];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const { expectedRevisionNo, reason } = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		if (
			typeof reason !== "string" ||
			reason.trim().length === 0 ||
			reason.trim().length > 500
		) {
			return fail(c, "PEOPLE_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const settlement = await getPersonSettlement({
				db,
				userId: auth.userId,
				settlementId,
			});

			if (
				!settlement ||
				settlement.obligationId !== obligationId ||
				settlement.personId !== personId
			) {
				return fail(c, "PEOPLE_SETTLEMENT_NOT_FOUND", 404);
			}

			const result = await voidPersonSettlement({
				db,
				userId: auth.userId,
				settlementId,
				expectedRevisionNo,
				reason: reason.trim(),
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapPeopleDomainError(c, err);
		}
	},
);

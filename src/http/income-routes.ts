import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import {
	getIstanbulCalendarDate,
	validateIsoCalendarDate,
	validatePeriodMonth,
} from "../income/calendar";
import {
	createIncomeEntitlement,
	getIncomeEntitlement,
	reviseIncomeEntitlement,
	voidIncomeEntitlement,
} from "../income/entitlements";
import { IncomeError } from "../income/errors";
import {
	listBoundedIncomeEntitlements,
	listBoundedIncomeReceipts,
	listBoundedIncomeSources,
	PRODUCT_HTTP_SOURCE_TYPE,
	USER_EDIT_REASON_CODE,
	USER_VOID_REASON_CODE,
} from "../income/product-read-v2";
import { createIncomeSourceWithNaturalReplay } from "../income/product-source-v2";
import {
	createIncomeReceipt,
	getIncomeReceipt,
	reviseIncomeReceipt,
	voidIncomeReceipt,
} from "../income/receipts";
import { getMonthlyReferenceIncome } from "../income/reference";
import {
	createIncomeSettlement,
	getIncomeReceiptSettlement,
	reviseIncomeSettlement,
} from "../income/settlements";
import { archiveIncomeSource, getIncomeSource } from "../income/sources";
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

type IncomeEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const incomeRouter = new Hono<IncomeEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB
const SOURCE_CODE_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;

function fail(c: Context<IncomeEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapIncomeDomainError(c: Context<IncomeEnv>, err: unknown) {
	if (err instanceof IncomeError) {
		switch (err.code) {
			case "INCOME_INVALID_INPUT":
			case "INCOME_LEDGER_ACCOUNT_INVALID":
			case "INCOME_DESTINATION_ACCOUNT_INVALID":
				return fail(c, err.code, 400);
			case "INCOME_SOURCE_NOT_FOUND":
			case "INCOME_ENTITLEMENT_NOT_FOUND":
			case "INCOME_RECEIPT_NOT_FOUND":
			case "INCOME_SETTLEMENT_NOT_FOUND":
				return fail(c, err.code, 404);
			case "INCOME_SOURCE_ARCHIVED":
			case "INCOME_SOURCE_CODE_CONFLICT":
			case "INCOME_IDEMPOTENCY_CONFLICT":
			case "INCOME_ENTITLEMENT_PERIOD_CONFLICT":
			case "INCOME_ENTITLEMENT_REVISION_CONFLICT":
			case "INCOME_ENTITLEMENT_ALREADY_VOIDED":
			case "INCOME_RECEIPT_REVISION_CONFLICT":
			case "INCOME_RECEIPT_ALREADY_VOIDED":
			case "INCOME_SETTLEMENT_ALREADY_EXISTS":
			case "INCOME_SETTLEMENT_REVISION_CONFLICT":
			case "INCOME_SETTLEMENT_CONFLICT":
				return fail(c, err.code, 409);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

// Global middlewares for all Income product routes
incomeRouter.use("*", sameOriginMutationGuard());
incomeRouter.use("*", requireAuthenticatedSession);
incomeRouter.post(
	"*",
	bodyLimit({
		maxSize: BODY_LIMIT_BYTES,
		onError: (c) => fail(c, "INCOME_INVALID_INPUT", 400),
	}),
);

// ============================================================================
// 1. SOURCES
// ============================================================================

// 1.1 GET /income/sources -- Bounded income sources list
incomeRouter.get("/sources", async (c) => {
	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const rawIncludeArchived = c.req.query("includeArchived");
	let includeArchived = false;
	if (rawIncludeArchived !== undefined) {
		const trimmed = rawIncludeArchived.trim().toLowerCase();
		if (trimmed === "true") {
			includeArchived = true;
		} else if (trimmed === "false") {
			includeArchived = false;
		} else {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	const rawBeforeCreatedAt = c.req.query("beforeCreatedAt");
	let beforeCreatedAt: Date | undefined;
	if (rawBeforeCreatedAt !== undefined) {
		const parsed = parseCanonicalInstant(rawBeforeCreatedAt);
		if (!parsed) return fail(c, "INCOME_INVALID_INPUT", 400);
		beforeCreatedAt = parsed;
	}

	const rawBeforeSourceId = c.req.query("beforeSourceId");
	let beforeSourceId: string | undefined;
	if (rawBeforeSourceId !== undefined) {
		if (!isUuid(rawBeforeSourceId)) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		beforeSourceId = rawBeforeSourceId.trim();
	}

	if (
		(beforeCreatedAt && !beforeSourceId) ||
		(!beforeCreatedAt && beforeSourceId)
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await listBoundedIncomeSources({
			db,
			userId,
			limit: limitRes.limit,
			includeArchived,
			beforeCreatedAt,
			beforeSourceId,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 1.2 GET /income/sources/:sourceId -- Source detail
incomeRouter.get("/sources/:sourceId", async (c) => {
	const sourceId = c.req.param("sourceId");
	if (!isUuid(sourceId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const source = await getIncomeSource({
			db,
			userId,
			sourceId,
		});

		return c.json(
			{
				sourceId: source.id,
				code: source.code,
				name: source.name,
				nature: source.nature,
				referenceMethod: source.referenceMethod,
				expectedMonthlyAmount: source.expectedMonthlyAmount,
				seasonalMonthsPerYear: source.seasonalMonthsPerYear,
				rollingMedianMonths: source.rollingMedianMonths,
				incomeLedgerAccountId: source.incomeLedgerAccountId,
				activeFrom: source.activeFrom,
				activeUntil: source.activeUntil,
				createdAt: source.createdAt.toISOString(),
				archivedAt: source.archivedAt ? source.archivedAt.toISOString() : null,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 1.3 POST /income/sources -- Create source with natural-key replay
incomeRouter.post("/sources", async (c) => {
	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
	const body = parsed.value;

	if (
		!hasOnlyKeys(body, [
			"code",
			"name",
			"nature",
			"referenceMethod",
			"expectedMonthlyAmount",
			"seasonalMonthsPerYear",
			"rollingMedianMonths",
			"incomeLedgerAccountId",
			"activeFrom",
			"activeUntil",
		])
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawCode = body.code;
	if (typeof rawCode !== "string") return fail(c, "INCOME_INVALID_INPUT", 400);
	const code = rawCode.trim().toUpperCase();
	if (!SOURCE_CODE_REGEX.test(code))
		return fail(c, "INCOME_INVALID_INPUT", 400);

	const rawName = body.name;
	if (
		typeof rawName !== "string" ||
		rawName.trim().length === 0 ||
		rawName.trim().length > 120
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}
	const name = rawName.trim();

	const rawNature = body.nature;
	if (
		typeof rawNature !== "string" ||
		!["REGULAR", "EXTRA", "SUPPORT"].includes(rawNature)
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}
	const nature = rawNature as "REGULAR" | "EXTRA" | "SUPPORT";

	const rawRefMethod = body.referenceMethod;
	if (
		typeof rawRefMethod !== "string" ||
		![
			"FIXED_MONTHLY",
			"SEASONAL_ANNUALIZED",
			"ROLLING_MEDIAN",
			"EXCLUDED",
		].includes(rawRefMethod)
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}
	const referenceMethod = rawRefMethod as
		| "FIXED_MONTHLY"
		| "SEASONAL_ANNUALIZED"
		| "ROLLING_MEDIAN"
		| "EXCLUDED";

	let expectedMonthlyAmount: string | undefined;
	if (
		body.expectedMonthlyAmount !== undefined &&
		body.expectedMonthlyAmount !== null
	) {
		if (typeof body.expectedMonthlyAmount !== "string") {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		expectedMonthlyAmount = body.expectedMonthlyAmount;
	}

	let seasonalMonthsPerYear: number | undefined;
	if (
		body.seasonalMonthsPerYear !== undefined &&
		body.seasonalMonthsPerYear !== null
	) {
		if (
			typeof body.seasonalMonthsPerYear !== "number" ||
			!Number.isInteger(body.seasonalMonthsPerYear) ||
			body.seasonalMonthsPerYear < 1 ||
			body.seasonalMonthsPerYear > 12
		) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		seasonalMonthsPerYear = body.seasonalMonthsPerYear;
	}

	let rollingMedianMonths: number | undefined;
	if (
		body.rollingMedianMonths !== undefined &&
		body.rollingMedianMonths !== null
	) {
		if (
			typeof body.rollingMedianMonths !== "number" ||
			!Number.isInteger(body.rollingMedianMonths) ||
			body.rollingMedianMonths < 1 ||
			body.rollingMedianMonths > 24
		) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		rollingMedianMonths = body.rollingMedianMonths;
	}

	const rawAccountId = body.incomeLedgerAccountId;
	if (!isUuid(rawAccountId)) return fail(c, "INCOME_INVALID_INPUT", 400);
	const incomeLedgerAccountId = rawAccountId.trim();

	const rawActiveFrom = body.activeFrom;
	if (typeof rawActiveFrom !== "string")
		return fail(c, "INCOME_INVALID_INPUT", 400);
	let activeFrom: string;
	try {
		activeFrom = validateIsoCalendarDate(rawActiveFrom);
	} catch {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	let activeUntil: string | null | undefined;
	if (body.activeUntil !== undefined && body.activeUntil !== null) {
		if (typeof body.activeUntil !== "string")
			return fail(c, "INCOME_INVALID_INPUT", 400);
		try {
			activeUntil = validateIsoCalendarDate(body.activeUntil);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await createIncomeSourceWithNaturalReplay({
			db,
			userId,
			code,
			name,
			nature,
			referenceMethod,
			expectedMonthlyAmount,
			seasonalMonthsPerYear,
			rollingMedianMonths,
			incomeLedgerAccountId,
			activeFrom,
			activeUntil,
		});

		return c.json(
			{
				sourceId: result.incomeSource.id,
				code: result.incomeSource.code,
				name: result.incomeSource.name,
				nature: result.incomeSource.nature,
				referenceMethod: result.incomeSource.referenceMethod,
				expectedMonthlyAmount: result.incomeSource.expectedMonthlyAmount,
				seasonalMonthsPerYear: result.incomeSource.seasonalMonthsPerYear,
				rollingMedianMonths: result.incomeSource.rollingMedianMonths,
				incomeLedgerAccountId: result.incomeSource.incomeLedgerAccountId,
				activeFrom: result.incomeSource.activeFrom,
				activeUntil: result.incomeSource.activeUntil,
				createdAt: result.incomeSource.createdAt.toISOString(),
				archivedAt: result.incomeSource.archivedAt
					? result.incomeSource.archivedAt.toISOString()
					: null,
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 1.4 POST /income/sources/:sourceId/archive -- Archive source
incomeRouter.post("/sources/:sourceId/archive", async (c) => {
	const sourceId = c.req.param("sourceId");
	if (!isUuid(sourceId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	// Optional closed body
	const contentType = c.req.header("content-type");
	if (contentType) {
		const parsed = await readJsonObject(c);
		if (!parsed.ok || !hasOnlyKeys(parsed.value, [])) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const source = await archiveIncomeSource({
			db,
			userId,
			sourceId,
		});

		return c.json(
			{
				sourceId: source.id,
				code: source.code,
				name: source.name,
				nature: source.nature,
				referenceMethod: source.referenceMethod,
				expectedMonthlyAmount: source.expectedMonthlyAmount,
				seasonalMonthsPerYear: source.seasonalMonthsPerYear,
				rollingMedianMonths: source.rollingMedianMonths,
				incomeLedgerAccountId: source.incomeLedgerAccountId,
				activeFrom: source.activeFrom,
				activeUntil: source.activeUntil,
				createdAt: source.createdAt.toISOString(),
				archivedAt: source.archivedAt ? source.archivedAt.toISOString() : null,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// ============================================================================
// 2. ENTITLEMENTS
// ============================================================================

// 2.1 GET /income/entitlements -- Bounded entitlement list
incomeRouter.get("/entitlements", async (c) => {
	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const rawSourceId = c.req.query("sourceId");
	let sourceId: string | undefined;
	if (rawSourceId !== undefined) {
		if (!isUuid(rawSourceId)) return fail(c, "INCOME_INVALID_INPUT", 400);
		sourceId = rawSourceId.trim();
	}

	const rawFrom = c.req.query("periodMonthFrom");
	let periodMonthFrom: string | undefined;
	if (rawFrom !== undefined) {
		try {
			periodMonthFrom = validatePeriodMonth(rawFrom);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	const rawUntil = c.req.query("periodMonthUntil");
	let periodMonthUntil: string | undefined;
	if (rawUntil !== undefined) {
		try {
			periodMonthUntil = validatePeriodMonth(rawUntil);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	if (
		periodMonthFrom &&
		periodMonthUntil &&
		periodMonthFrom > periodMonthUntil
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawOverdueAsOf = c.req.query("overdueAsOf");
	let overdueAsOf: string | undefined;
	if (rawOverdueAsOf !== undefined) {
		try {
			overdueAsOf = validateIsoCalendarDate(rawOverdueAsOf);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	const rawBeforePeriod = c.req.query("beforePeriodMonth");
	let beforePeriodMonth: string | undefined;
	if (rawBeforePeriod !== undefined) {
		try {
			beforePeriodMonth = validatePeriodMonth(rawBeforePeriod);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	const rawBeforeEntId = c.req.query("beforeEntitlementId");
	let beforeEntitlementId: string | undefined;
	if (rawBeforeEntId !== undefined) {
		if (!isUuid(rawBeforeEntId)) return fail(c, "INCOME_INVALID_INPUT", 400);
		beforeEntitlementId = rawBeforeEntId.trim();
	}

	if (
		(beforePeriodMonth && !beforeEntitlementId) ||
		(!beforePeriodMonth && beforeEntitlementId)
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await listBoundedIncomeEntitlements({
			db,
			userId,
			limit: limitRes.limit,
			sourceId,
			periodMonthFrom,
			periodMonthUntil,
			overdueAsOf,
			beforePeriodMonth,
			beforeEntitlementId,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 2.2 GET /income/entitlements/:entitlementId -- Entitlement detail
incomeRouter.get("/entitlements/:entitlementId", async (c) => {
	const entitlementId = c.req.param("entitlementId");
	if (!isUuid(entitlementId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	const rawOverdueAsOf = c.req.query("overdueAsOf");
	let overdueAsOf: string | undefined;
	if (rawOverdueAsOf !== undefined) {
		try {
			overdueAsOf = validateIsoCalendarDate(rawOverdueAsOf);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const ent = await getIncomeEntitlement({
			db,
			userId,
			entitlementId,
			asOf: overdueAsOf,
		});

		return c.json(
			{
				entitlementId: ent.entitlementId,
				sourceId: ent.sourceId,
				sourceCode: ent.sourceCode,
				sourceName: ent.sourceName,
				periodMonth: ent.periodMonth,
				revisionNo: ent.revisionNo,
				status: ent.status,
				amount: ent.amount,
				allocatedAmount: ent.allocatedAmount,
				outstandingAmount: ent.outstandingAmount,
				settlementStatus: ent.settlementStatus,
				expectedReceiptOn: ent.expectedReceiptOn,
				overdue: ent.overdue,
				note: ent.note,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 2.3 POST /income/entitlements -- Create entitlement
incomeRouter.post("/entitlements", async (c) => {
	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
	const body = parsed.value;

	if (
		!hasOnlyKeys(body, [
			"sourceId",
			"periodMonth",
			"amount",
			"expectedReceiptOn",
			"note",
		])
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawSourceId = body.sourceId;
	if (!isUuid(rawSourceId)) return fail(c, "INCOME_INVALID_INPUT", 400);
	const sourceId = rawSourceId.trim();

	const rawPeriod = body.periodMonth;
	if (typeof rawPeriod !== "string")
		return fail(c, "INCOME_INVALID_INPUT", 400);
	let periodMonth: string;
	try {
		periodMonth = validatePeriodMonth(rawPeriod);
	} catch {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawAmount = body.amount;
	if (typeof rawAmount !== "string")
		return fail(c, "INCOME_INVALID_INPUT", 400);
	const amount = rawAmount.trim();

	let expectedReceiptOn: string | null | undefined;
	if (body.expectedReceiptOn !== undefined && body.expectedReceiptOn !== null) {
		if (typeof body.expectedReceiptOn !== "string")
			return fail(c, "INCOME_INVALID_INPUT", 400);
		try {
			expectedReceiptOn = validateIsoCalendarDate(body.expectedReceiptOn);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	let note: string | null | undefined;
	if (body.note !== undefined && body.note !== null) {
		if (typeof body.note !== "string" || body.note.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		note = body.note;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await createIncomeEntitlement({
			db,
			userId,
			sourceId,
			periodMonth,
			amount,
			expectedReceiptOn,
			note,
			idempotencyKey: idem.key,
			provenance: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
			},
		});

		return c.json(
			{
				entitlement: {
					entitlementId: result.incomeEntitlement.entitlementId,
					sourceId: result.incomeEntitlement.sourceId,
					sourceCode: result.incomeEntitlement.sourceCode,
					sourceName: result.incomeEntitlement.sourceName,
					periodMonth: result.incomeEntitlement.periodMonth,
					revisionNo: result.incomeEntitlement.revisionNo,
					status: result.incomeEntitlement.status,
					amount: result.incomeEntitlement.amount,
					allocatedAmount: result.incomeEntitlement.allocatedAmount,
					outstandingAmount: result.incomeEntitlement.outstandingAmount,
					settlementStatus: result.incomeEntitlement.settlementStatus,
					expectedReceiptOn: result.incomeEntitlement.expectedReceiptOn,
					overdue: result.incomeEntitlement.overdue,
					note: result.incomeEntitlement.note,
				},
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 2.4 POST /income/entitlements/:entitlementId/revisions -- Revise entitlement
incomeRouter.post("/entitlements/:entitlementId/revisions", async (c) => {
	const entitlementId = c.req.param("entitlementId");
	if (!isUuid(entitlementId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
	const body = parsed.value;

	if (
		!hasOnlyKeys(body, [
			"expectedRevisionNo",
			"amount",
			"expectedReceiptOn",
			"note",
			"reasonNote",
		])
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawRevNo = body.expectedRevisionNo;
	if (
		typeof rawRevNo !== "number" ||
		!Number.isInteger(rawRevNo) ||
		rawRevNo < 1
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}
	const expectedRevisionNo = rawRevNo;

	const rawAmount = body.amount;
	if (typeof rawAmount !== "string")
		return fail(c, "INCOME_INVALID_INPUT", 400);
	const amount = rawAmount.trim();

	let expectedReceiptOn: string | null | undefined;
	if (body.expectedReceiptOn !== undefined && body.expectedReceiptOn !== null) {
		if (typeof body.expectedReceiptOn !== "string")
			return fail(c, "INCOME_INVALID_INPUT", 400);
		try {
			expectedReceiptOn = validateIsoCalendarDate(body.expectedReceiptOn);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	let note: string | null | undefined;
	if (body.note !== undefined && body.note !== null) {
		if (typeof body.note !== "string" || body.note.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		note = body.note;
	}

	let reasonNote: string | null | undefined;
	if (body.reasonNote !== undefined && body.reasonNote !== null) {
		if (typeof body.reasonNote !== "string" || body.reasonNote.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		reasonNote = body.reasonNote;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await reviseIncomeEntitlement({
			db,
			userId,
			entitlementId,
			expectedRevisionNo,
			amount,
			expectedReceiptOn,
			note,
			idempotencyKey: idem.key,
			reasonCode: USER_EDIT_REASON_CODE,
			reasonNote,
			provenance: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
			},
		});

		return c.json(
			{
				entitlement: {
					entitlementId: result.incomeEntitlement.entitlementId,
					sourceId: result.incomeEntitlement.sourceId,
					sourceCode: result.incomeEntitlement.sourceCode,
					sourceName: result.incomeEntitlement.sourceName,
					periodMonth: result.incomeEntitlement.periodMonth,
					revisionNo: result.incomeEntitlement.revisionNo,
					status: result.incomeEntitlement.status,
					amount: result.incomeEntitlement.amount,
					allocatedAmount: result.incomeEntitlement.allocatedAmount,
					outstandingAmount: result.incomeEntitlement.outstandingAmount,
					settlementStatus: result.incomeEntitlement.settlementStatus,
					expectedReceiptOn: result.incomeEntitlement.expectedReceiptOn,
					overdue: result.incomeEntitlement.overdue,
					note: result.incomeEntitlement.note,
				},
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 2.5 POST /income/entitlements/:entitlementId/void -- Void entitlement
incomeRouter.post("/entitlements/:entitlementId/void", async (c) => {
	const entitlementId = c.req.param("entitlementId");
	if (!isUuid(entitlementId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
	const body = parsed.value;

	if (!hasOnlyKeys(body, ["expectedRevisionNo", "reasonNote"])) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawRevNo = body.expectedRevisionNo;
	if (
		typeof rawRevNo !== "number" ||
		!Number.isInteger(rawRevNo) ||
		rawRevNo < 1
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}
	const expectedRevisionNo = rawRevNo;

	let reasonNote: string | null | undefined;
	if (body.reasonNote !== undefined && body.reasonNote !== null) {
		if (typeof body.reasonNote !== "string" || body.reasonNote.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		reasonNote = body.reasonNote;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await voidIncomeEntitlement({
			db,
			userId,
			entitlementId,
			expectedRevisionNo,
			idempotencyKey: idem.key,
			reasonCode: USER_VOID_REASON_CODE,
			reasonNote,
			provenance: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
			},
		});

		return c.json(
			{
				entitlement: {
					entitlementId: result.incomeEntitlement.entitlementId,
					sourceId: result.incomeEntitlement.sourceId,
					sourceCode: result.incomeEntitlement.sourceCode,
					sourceName: result.incomeEntitlement.sourceName,
					periodMonth: result.incomeEntitlement.periodMonth,
					revisionNo: result.incomeEntitlement.revisionNo,
					status: result.incomeEntitlement.status,
					amount: result.incomeEntitlement.amount,
					allocatedAmount: result.incomeEntitlement.allocatedAmount,
					outstandingAmount: result.incomeEntitlement.outstandingAmount,
					settlementStatus: result.incomeEntitlement.settlementStatus,
					expectedReceiptOn: result.incomeEntitlement.expectedReceiptOn,
					overdue: result.incomeEntitlement.overdue,
					note: result.incomeEntitlement.note,
				},
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// ============================================================================
// 3. RECEIPTS
// ============================================================================

// 3.1 GET /income/receipts -- Bounded income receipts list
incomeRouter.get("/receipts", async (c) => {
	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const rawSourceId = c.req.query("sourceId");
	let sourceId: string | undefined;
	if (rawSourceId !== undefined) {
		if (!isUuid(rawSourceId)) return fail(c, "INCOME_INVALID_INPUT", 400);
		sourceId = rawSourceId.trim();
	}

	const rawFrom = c.req.query("from");
	let fromDate: Date | undefined;
	if (rawFrom !== undefined) {
		const parsed = parseCanonicalInstant(rawFrom);
		if (!parsed) return fail(c, "INCOME_INVALID_INPUT", 400);
		fromDate = parsed;
	}

	const rawTo = c.req.query("to");
	let toDate: Date | undefined;
	if (rawTo !== undefined) {
		const parsed = parseCanonicalInstant(rawTo);
		if (!parsed) return fail(c, "INCOME_INVALID_INPUT", 400);
		toDate = parsed;
	}

	if (fromDate && toDate && fromDate > toDate) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawIncludeVoided = c.req.query("includeVoided");
	let includeVoided = false;
	if (rawIncludeVoided !== undefined) {
		const trimmed = rawIncludeVoided.trim().toLowerCase();
		if (trimmed === "true") {
			includeVoided = true;
		} else if (trimmed === "false") {
			includeVoided = false;
		} else {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	}

	const rawBeforeReceivedAt = c.req.query("beforeReceivedAt");
	let beforeReceivedAt: Date | undefined;
	if (rawBeforeReceivedAt !== undefined) {
		const parsed = parseCanonicalInstant(rawBeforeReceivedAt);
		if (!parsed) return fail(c, "INCOME_INVALID_INPUT", 400);
		beforeReceivedAt = parsed;
	}

	const rawBeforeReceiptId = c.req.query("beforeIncomeReceiptId");
	let beforeIncomeReceiptId: string | undefined;
	if (rawBeforeReceiptId !== undefined) {
		if (!isUuid(rawBeforeReceiptId))
			return fail(c, "INCOME_INVALID_INPUT", 400);
		beforeIncomeReceiptId = rawBeforeReceiptId.trim();
	}

	if (
		(beforeReceivedAt && !beforeIncomeReceiptId) ||
		(!beforeReceivedAt && beforeIncomeReceiptId)
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await listBoundedIncomeReceipts({
			db,
			userId,
			limit: limitRes.limit,
			sourceId,
			fromDate,
			toDate,
			includeVoided,
			beforeReceivedAt,
			beforeIncomeReceiptId,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 3.2 GET /income/receipts/:incomeReceiptId -- Receipt detail
incomeRouter.get("/receipts/:incomeReceiptId", async (c) => {
	const incomeReceiptId = c.req.param("incomeReceiptId");
	if (!isUuid(incomeReceiptId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const receipt = await getIncomeReceipt({
			db,
			userId,
			incomeReceiptId,
		});

		return c.json(
			{
				incomeReceiptId: receipt.incomeReceiptId,
				sourceId: receipt.sourceId,
				sourceCode: receipt.sourceCode,
				sourceName: receipt.sourceName,
				status: receipt.status,
				revisionNo: receipt.revisionNo,
				receivedAt: receipt.receivedAt.toISOString(),
				amount: receipt.amount,
				destinationAccountId: receipt.destinationAccountId,
				note: receipt.note,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 3.3 POST /income/receipts -- Create receipt (realized cash income)
incomeRouter.post("/receipts", async (c) => {
	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
	const body = parsed.value;

	if (
		!hasOnlyKeys(body, [
			"sourceId",
			"receivedAt",
			"amount",
			"destinationAccountId",
			"note",
		])
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawSourceId = body.sourceId;
	if (!isUuid(rawSourceId)) return fail(c, "INCOME_INVALID_INPUT", 400);
	const sourceId = rawSourceId.trim();

	const rawReceivedAt = body.receivedAt;
	const receivedAt = parseCanonicalInstant(rawReceivedAt);
	if (!receivedAt) return fail(c, "INCOME_INVALID_INPUT", 400);

	const rawAmount = body.amount;
	if (typeof rawAmount !== "string")
		return fail(c, "INCOME_INVALID_INPUT", 400);
	const amount = rawAmount.trim();

	const rawDestId = body.destinationAccountId;
	if (!isUuid(rawDestId)) return fail(c, "INCOME_INVALID_INPUT", 400);
	const destinationAccountId = rawDestId.trim();

	let note: string | null | undefined;
	if (body.note !== undefined && body.note !== null) {
		if (typeof body.note !== "string" || body.note.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		note = body.note;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await createIncomeReceipt({
			db,
			userId,
			sourceId,
			idempotencyKey: idem.key,
			receivedAt,
			amount,
			destinationAccountId,
			note,
			provenance: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
			},
		});

		return c.json(
			{
				receipt: {
					incomeReceiptId: result.incomeReceipt.incomeReceiptId,
					sourceId: result.incomeReceipt.sourceId,
					sourceCode: result.incomeReceipt.sourceCode,
					sourceName: result.incomeReceipt.sourceName,
					status: result.incomeReceipt.status,
					revisionNo: result.incomeReceipt.revisionNo,
					receivedAt: result.incomeReceipt.receivedAt.toISOString(),
					amount: result.incomeReceipt.amount,
					destinationAccountId: result.incomeReceipt.destinationAccountId,
					note: result.incomeReceipt.note,
				},
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 3.4 POST /income/receipts/:incomeReceiptId/revisions -- Revise receipt
incomeRouter.post("/receipts/:incomeReceiptId/revisions", async (c) => {
	const incomeReceiptId = c.req.param("incomeReceiptId");
	if (!isUuid(incomeReceiptId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
	const body = parsed.value;

	if (
		!hasOnlyKeys(body, [
			"expectedRevisionNo",
			"receivedAt",
			"amount",
			"destinationAccountId",
			"note",
			"reasonNote",
		])
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawRevNo = body.expectedRevisionNo;
	if (
		typeof rawRevNo !== "number" ||
		!Number.isInteger(rawRevNo) ||
		rawRevNo < 1
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}
	const expectedRevisionNo = rawRevNo;

	const rawReceivedAt = body.receivedAt;
	const receivedAt = parseCanonicalInstant(rawReceivedAt);
	if (!receivedAt) return fail(c, "INCOME_INVALID_INPUT", 400);

	const rawAmount = body.amount;
	if (typeof rawAmount !== "string")
		return fail(c, "INCOME_INVALID_INPUT", 400);
	const amount = rawAmount.trim();

	const rawDestId = body.destinationAccountId;
	if (!isUuid(rawDestId)) return fail(c, "INCOME_INVALID_INPUT", 400);
	const destinationAccountId = rawDestId.trim();

	let note: string | null | undefined;
	if (body.note !== undefined && body.note !== null) {
		if (typeof body.note !== "string" || body.note.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		note = body.note;
	}

	let reasonNote: string | null | undefined;
	if (body.reasonNote !== undefined && body.reasonNote !== null) {
		if (typeof body.reasonNote !== "string" || body.reasonNote.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		reasonNote = body.reasonNote;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await reviseIncomeReceipt({
			db,
			userId,
			incomeReceiptId,
			expectedRevisionNo,
			idempotencyKey: idem.key,
			receivedAt,
			amount,
			destinationAccountId,
			note,
			reasonCode: USER_EDIT_REASON_CODE,
			reasonNote,
			provenance: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
			},
		});

		return c.json(
			{
				receipt: {
					incomeReceiptId: result.incomeReceipt.incomeReceiptId,
					sourceId: result.incomeReceipt.sourceId,
					sourceCode: result.incomeReceipt.sourceCode,
					sourceName: result.incomeReceipt.sourceName,
					status: result.incomeReceipt.status,
					revisionNo: result.incomeReceipt.revisionNo,
					receivedAt: result.incomeReceipt.receivedAt.toISOString(),
					amount: result.incomeReceipt.amount,
					destinationAccountId: result.incomeReceipt.destinationAccountId,
					note: result.incomeReceipt.note,
				},
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 3.5 POST /income/receipts/:incomeReceiptId/void -- Void receipt
incomeRouter.post("/receipts/:incomeReceiptId/void", async (c) => {
	const incomeReceiptId = c.req.param("incomeReceiptId");
	if (!isUuid(incomeReceiptId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
	const body = parsed.value;

	if (!hasOnlyKeys(body, ["expectedRevisionNo", "reasonNote"])) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawRevNo = body.expectedRevisionNo;
	if (
		typeof rawRevNo !== "number" ||
		!Number.isInteger(rawRevNo) ||
		rawRevNo < 1
	) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}
	const expectedRevisionNo = rawRevNo;

	let reasonNote: string | null | undefined;
	if (body.reasonNote !== undefined && body.reasonNote !== null) {
		if (typeof body.reasonNote !== "string" || body.reasonNote.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		reasonNote = body.reasonNote;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await voidIncomeReceipt({
			db,
			userId,
			incomeReceiptId,
			expectedRevisionNo,
			idempotencyKey: idem.key,
			reasonCode: USER_VOID_REASON_CODE,
			reasonNote,
			provenance: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
			},
		});

		return c.json(
			{
				receipt: {
					incomeReceiptId: result.incomeReceipt.incomeReceiptId,
					sourceId: result.incomeReceipt.sourceId,
					sourceCode: result.incomeReceipt.sourceCode,
					sourceName: result.incomeReceipt.sourceName,
					status: result.incomeReceipt.status,
					revisionNo: result.incomeReceipt.revisionNo,
					receivedAt: result.incomeReceipt.receivedAt.toISOString(),
					amount: result.incomeReceipt.amount,
					destinationAccountId: result.incomeReceipt.destinationAccountId,
					note: result.incomeReceipt.note,
				},
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// ============================================================================
// 4. SETTLEMENTS
// ============================================================================

// 4.1 GET /income/receipts/:incomeReceiptId/settlement -- Get receipt settlement
incomeRouter.get("/receipts/:incomeReceiptId/settlement", async (c) => {
	const incomeReceiptId = c.req.param("incomeReceiptId");
	if (!isUuid(incomeReceiptId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const res = await getIncomeReceiptSettlement({
			db,
			userId,
			incomeReceiptId,
		});

		return c.json(
			{
				incomeReceiptId: res.incomeReceiptId,
				receiptAmount: res.receiptAmount,
				allocatedAmount: res.allocatedAmount,
				unallocatedAmount: res.unallocatedAmount,
				revisionNo: res.revisionNo,
				allocations: res.allocations,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 4.2 POST /income/receipts/:incomeReceiptId/settlement -- Create receipt settlement
incomeRouter.post("/receipts/:incomeReceiptId/settlement", async (c) => {
	const incomeReceiptId = c.req.param("incomeReceiptId");
	if (!isUuid(incomeReceiptId)) return fail(c, "INCOME_INVALID_INPUT", 400);

	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
	const body = parsed.value;

	if (!hasOnlyKeys(body, ["allocations", "note"])) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const rawAllocs = body.allocations;
	if (!Array.isArray(rawAllocs) || rawAllocs.length === 0) {
		return fail(c, "INCOME_INVALID_INPUT", 400);
	}

	const allocations: Array<{ entitlementId: string; amount: string }> = [];
	for (const a of rawAllocs) {
		if (
			typeof a !== "object" ||
			a === null ||
			Array.isArray(a) ||
			!hasOnlyKeys(a as Record<string, unknown>, ["entitlementId", "amount"])
		) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		const obj = a as { entitlementId?: unknown; amount?: unknown };
		if (!isUuid(obj.entitlementId)) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		if (typeof obj.amount !== "string") {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		allocations.push({
			entitlementId: obj.entitlementId.trim(),
			amount: obj.amount.trim(),
		});
	}

	let note: string | null | undefined;
	if (body.note !== undefined && body.note !== null) {
		if (typeof body.note !== "string" || body.note.length > 500) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		note = body.note;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await createIncomeSettlement({
			db,
			userId,
			incomeReceiptId,
			allocations,
			note,
			idempotencyKey: idem.key,
			provenance: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
			},
		});

		return c.json(
			{
				settlement: {
					incomeReceiptId: result.settlement.incomeReceiptId,
					receiptAmount: result.settlement.receiptAmount,
					allocatedAmount: result.settlement.allocatedAmount,
					unallocatedAmount: result.settlement.unallocatedAmount,
					revisionNo: result.settlement.revisionNo,
					allocations: result.settlement.allocations,
				},
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

// 4.3 POST /income/receipts/:incomeReceiptId/settlement/revisions -- Revise settlement (allocations: [] clears)
incomeRouter.post(
	"/receipts/:incomeReceiptId/settlement/revisions",
	async (c) => {
		const incomeReceiptId = c.req.param("incomeReceiptId");
		if (!isUuid(incomeReceiptId)) return fail(c, "INCOME_INVALID_INPUT", 400);

		const idem = readIdempotencyKey(c);
		if (!idem.ok) return fail(c, "INCOME_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "INCOME_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"expectedRevisionNo",
				"allocations",
				"note",
				"reasonNote",
			])
		) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}

		const rawRevNo = body.expectedRevisionNo;
		if (
			typeof rawRevNo !== "number" ||
			!Number.isInteger(rawRevNo) ||
			rawRevNo < 1
		) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
		const expectedRevisionNo = rawRevNo;

		const rawAllocs = body.allocations;
		if (!Array.isArray(rawAllocs)) {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}

		const allocations: Array<{ entitlementId: string; amount: string }> = [];
		for (const a of rawAllocs) {
			if (
				typeof a !== "object" ||
				a === null ||
				Array.isArray(a) ||
				!hasOnlyKeys(a as Record<string, unknown>, ["entitlementId", "amount"])
			) {
				return fail(c, "INCOME_INVALID_INPUT", 400);
			}
			const obj = a as { entitlementId?: unknown; amount?: unknown };
			if (!isUuid(obj.entitlementId)) {
				return fail(c, "INCOME_INVALID_INPUT", 400);
			}
			if (typeof obj.amount !== "string") {
				return fail(c, "INCOME_INVALID_INPUT", 400);
			}
			allocations.push({
				entitlementId: obj.entitlementId.trim(),
				amount: obj.amount.trim(),
			});
		}

		let note: string | null | undefined;
		if (body.note !== undefined && body.note !== null) {
			if (typeof body.note !== "string" || body.note.length > 500) {
				return fail(c, "INCOME_INVALID_INPUT", 400);
			}
			note = body.note;
		}

		let reasonNote: string | null | undefined;
		if (body.reasonNote !== undefined && body.reasonNote !== null) {
			if (typeof body.reasonNote !== "string" || body.reasonNote.length > 500) {
				return fail(c, "INCOME_INVALID_INPUT", 400);
			}
			reasonNote = body.reasonNote;
		}

		try {
			const db = createDatabase(getDatabaseUrl(c.env));
			const userId = c.get("auth").userId;

			const result = await reviseIncomeSettlement({
				db,
				userId,
				incomeReceiptId,
				expectedRevisionNo,
				allocations,
				note,
				idempotencyKey: idem.key,
				reasonCode: USER_EDIT_REASON_CODE,
				reasonNote,
				provenance: {
					type: PRODUCT_HTTP_SOURCE_TYPE,
					ref: idem.key,
				},
			});

			return c.json(
				{
					settlement: {
						incomeReceiptId: result.settlement.incomeReceiptId,
						receiptAmount: result.settlement.receiptAmount,
						allocatedAmount: result.settlement.allocatedAmount,
						unallocatedAmount: result.settlement.unallocatedAmount,
						revisionNo: result.settlement.revisionNo,
						allocations: result.settlement.allocations,
					},
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapIncomeDomainError(c, err);
		}
	},
);

// ============================================================================
// 5. MONTHLY REFERENCE INCOME
// ============================================================================

// 5.1 GET /income/reference -- Monthly reference baseline calculation
incomeRouter.get("/reference", async (c) => {
	const rawAsOf = c.req.query("asOf");
	let asOf: string;
	if (rawAsOf !== undefined) {
		try {
			asOf = validateIsoCalendarDate(rawAsOf);
		} catch {
			return fail(c, "INCOME_INVALID_INPUT", 400);
		}
	} else {
		asOf = getIstanbulCalendarDate(new Date());
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const res = await getMonthlyReferenceIncome({
			db,
			userId,
			asOf,
		});

		return c.json(
			{
				asOf: res.asOf,
				currency: res.currency,
				total: res.total,
				sources: res.sources,
			},
			200,
		);
	} catch (err) {
		return mapIncomeDomainError(c, err);
	}
});

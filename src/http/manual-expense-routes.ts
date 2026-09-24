import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import { ManualExpenseError } from "../manual-expenses/errors";
import {
	createManualExpense,
	getManualExpense,
	listManualExpenses,
	updateManualExpense,
	voidManualExpense,
} from "../manual-expenses/service";
import {
	type AuthVariables,
	requireAuthenticatedSession,
} from "./auth-middleware";
import { errorEnvelope, sameOriginMutationGuard } from "./transport";

type ManualExpenseEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables;
};

export const manualExpenseRouter = new Hono<ManualExpenseEnv>();

const BODY_LIMIT_BYTES = 32 * 1024;

function fail(c: Context<ManualExpenseEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapManualExpenseError(c: Context<ManualExpenseEnv>, err: unknown) {
	if (err instanceof ManualExpenseError) {
		return fail(c, err.code, err.status);
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

manualExpenseRouter.use("*", sameOriginMutationGuard());
manualExpenseRouter.use("*", requireAuthenticatedSession);
manualExpenseRouter.post(
	"*",
	bodyLimit({
		maxSize: BODY_LIMIT_BYTES,
		onError: (c) => fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400),
	}),
);

/**
 * GET /manual-expenses
 * Lists manual expenses for the user.
 */
manualExpenseRouter.get("/", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	const limitQuery = c.req.query("limit");
	const statusQuery = c.req.query("status");
	const beforeOccurredAt = c.req.query("beforeOccurredAt");
	const beforeTransactionId = c.req.query("beforeTransactionId");

	let limit = 50;
	if (limitQuery) {
		const parsed = Number.parseInt(limitQuery, 10);
		if (Number.isInteger(parsed) && parsed > 0 && parsed <= 100) {
			limit = parsed;
		} else {
			return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
		}
	}

	let status: "ACTIVE" | "VOIDED" | undefined;
	if (statusQuery) {
		if (statusQuery === "ACTIVE" || statusQuery === "VOIDED") {
			status = statusQuery;
		} else {
			return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
		}
	}

	let occurredAtDate: Date | undefined;
	if (beforeOccurredAt) {
		occurredAtDate = new Date(beforeOccurredAt);
		if (Number.isNaN(occurredAtDate.getTime())) {
			return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
		}
	}

	try {
		const result = await listManualExpenses(db, auth.userId, {
			limit,
			status,
			beforeOccurredAt: occurredAtDate,
			beforeTransactionId,
		});
		return c.json(result, 200);
	} catch (err) {
		return mapManualExpenseError(c, err);
	}
});

/**
 * GET /manual-expenses/:id
 * Gets a single manual expense.
 */
manualExpenseRouter.get("/:id", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));
	const expenseId = c.req.param("id");

	try {
		const expense = await getManualExpense(db, auth.userId, expenseId);
		return c.json({ expense }, 200);
	} catch (err) {
		return mapManualExpenseError(c, err);
	}
});

/**
 * POST /manual-expenses
 * Creates a new manual expense.
 */
manualExpenseRouter.post("/", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	const idempotencyKey =
		c.req.header("Idempotency-Key") || c.req.header("idempotency-key");
	if (!idempotencyKey || idempotencyKey.trim() === "") {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	if (
		typeof body !== "object" ||
		body === null ||
		typeof body.amount !== "string" ||
		typeof body.sourceAssetAccountId !== "string" ||
		typeof body.budgetCategory !== "string"
	) {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	let occurredAt: Date | undefined;
	if (body.occurredAt !== undefined) {
		if (typeof body.occurredAt !== "string") {
			return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
		}
		occurredAt = new Date(body.occurredAt);
		if (Number.isNaN(occurredAt.getTime())) {
			return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
		}
	}

	try {
		const result = await createManualExpense(db, auth.userId, {
			amount: body.amount,
			sourceAssetAccountId: body.sourceAssetAccountId,
			budgetCategory: body.budgetCategory,
			spendingCategoryId:
				typeof body.spendingCategoryId === "string"
					? body.spendingCategoryId
					: undefined,
			merchant: typeof body.merchant === "string" ? body.merchant : undefined,
			description:
				typeof body.description === "string" ? body.description : undefined,
			occurredAt,
			idempotencyKey,
			shortTermGoalId:
				typeof body.shortTermGoalId === "string"
					? body.shortTermGoalId
					: undefined,
		});

		return c.json(result, result.idempotentReplay ? 200 : 201);
	} catch (err) {
		return mapManualExpenseError(c, err);
	}
});

/**
 * POST /manual-expenses/:id
 * Updates an existing manual expense.
 */
manualExpenseRouter.post("/:id", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));
	const expenseId = c.req.param("id");

	const idempotencyKey =
		c.req.header("Idempotency-Key") || c.req.header("idempotency-key");
	if (!idempotencyKey || idempotencyKey.trim() === "") {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	if (
		typeof body !== "object" ||
		body === null ||
		typeof body.expectedRevisionNo !== "number"
	) {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	let occurredAt: Date | undefined;
	if (body.occurredAt !== undefined) {
		if (typeof body.occurredAt !== "string") {
			return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
		}
		occurredAt = new Date(body.occurredAt);
		if (Number.isNaN(occurredAt.getTime())) {
			return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
		}
	}

	try {
		const result = await updateManualExpense(db, auth.userId, expenseId, {
			expectedRevisionNo: body.expectedRevisionNo,
			amount: typeof body.amount === "string" ? body.amount : undefined,
			sourceAssetAccountId:
				typeof body.sourceAssetAccountId === "string"
					? body.sourceAssetAccountId
					: undefined,
			budgetCategory:
				typeof body.budgetCategory === "string"
					? body.budgetCategory
					: undefined,
			spendingCategoryId:
				typeof body.spendingCategoryId === "string"
					? body.spendingCategoryId
					: undefined,
			merchant: typeof body.merchant === "string" ? body.merchant : undefined,
			description:
				typeof body.description === "string" ? body.description : undefined,
			occurredAt,
			idempotencyKey,
			reasonNote:
				typeof body.reasonNote === "string" ? body.reasonNote : undefined,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapManualExpenseError(c, err);
	}
});

/**
 * POST /manual-expenses/:id/void
 * Voids a manual expense.
 */
manualExpenseRouter.post("/:id/void", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));
	const expenseId = c.req.param("id");

	const idempotencyKey =
		c.req.header("Idempotency-Key") || c.req.header("idempotency-key");
	if (!idempotencyKey || idempotencyKey.trim() === "") {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	if (
		typeof body !== "object" ||
		body === null ||
		typeof body.expectedRevisionNo !== "number"
	) {
		return fail(c, "MANUAL_EXPENSE_INVALID_INPUT", 400);
	}

	try {
		const result = await voidManualExpense(db, auth.userId, expenseId, {
			expectedRevisionNo: body.expectedRevisionNo,
			reason: typeof body.reason === "string" ? body.reason : undefined,
			idempotencyKey,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapManualExpenseError(c, err);
	}
});
